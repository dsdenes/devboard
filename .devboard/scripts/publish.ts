#!/usr/bin/env bun
/**
 * Verifies a pushed `main` commit's release and reports the running
 * dashboards. The release workflow builds, tests, publishes the launcher to
 * npmjs, and creates the private harness release; this script waits for that
 * run, proves the release and launcher exist, and never restarts a dashboard or
 * writes into a host. A dashboard installs a new harness itself and shows its
 * reload control until an operator restarts it.
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { dashboardInventory, describeInventory } from "../lib/inventory";
import { discoverInstances } from "../watchdog/discovery";

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

const harnessRoot = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const RELEASE_REPO = "dsdenes/devboard";
const LAUNCHER_PACKAGE = "@dsdenes/devboard";

function optionValue(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  args.splice(index, value === undefined ? 1 : 2);
  return value;
}

const waitSeconds = Number(optionValue("--wait-timeout") ?? "1800");
if (!Number.isFinite(waitSeconds) || waitSeconds <= 0) fail("--wait-timeout needs positive seconds");
const waitTimeoutMs = waitSeconds * 1000;

function usage(): never {
  console.log(`Usage: bun run publish [options]

Waits for the release workflow of the pushed main commit, verifies the private
harness release and the public launcher version, and reports every running
dashboard's installed and running versions without restarting it.

  --wait-timeout N    Seconds to wait for the workflow and propagation (default 1800).
  -h, --help          Show this text.`);
  process.exit(0);
}

if (args.includes("-h") || args.includes("--help")) usage();
if (args.length > 0) {
  console.error(`publish: unknown option ${args.join(" ")}`);
  usage();
}

function fail(message: string): never {
  console.error(`publish: ${message}`);
  process.exit(1);
}

function run(argv: string[], cwd = harnessRoot): CommandResult {
  const child = Bun.spawnSync({
    cmd: argv,
    cwd,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", GIT_TERMINAL_PROMPT: "0" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: child.exitCode ?? 1,
    stdout: child.stdout.toString().trim(),
    stderr: child.stderr.toString().trim(),
  };
}

function git(argv: string[]): CommandResult {
  return run(["git", "-C", repoRoot, ...argv]);
}

function mustGit(argv: string[], description: string): string {
  const result = git(argv);
  if (result.code !== 0) {
    fail(`${description}: ${result.stderr || result.stdout || `exit ${result.code}`}`);
  }
  return result.stdout;
}

function real(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function walkNewest(directory: string): number {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, walkNewest(path));
    else if (entry.isFile()) newest = Math.max(newest, statSync(path).mtimeMs);
  }
  return newest;
}


const top = run(["git", "-C", harnessRoot, "rev-parse", "--show-toplevel"]);
if (top.code !== 0) fail("the harness is not inside a git checkout");
const repoRoot = top.stdout;

const gitDir = real(mustGit(["rev-parse", "--absolute-git-dir"], "could not read the git dir"));
const commonDir = real(
  mustGit(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    "could not read the common git dir",
  ),
);
if (gitDir !== undefined && commonDir !== undefined && gitDir !== commonDir) {
  fail("run publish from the integration checkout, not a worktree");
}

const branch = mustGit(["symbolic-ref", "--short", "HEAD"], "the checkout is not on a branch");
if (branch !== "main") fail(`the integration line is main, not ${branch}`);

const remotes = mustGit(["remote"], "could not list remotes").split("\n").filter(Boolean);
const remote = remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : undefined;
if (remote === undefined) {
  fail("could not determine the canonical remote (origin, or the only remote)");
}

console.log(`publish: fetching ${remote}/main`);
const fetched = git(["fetch", "--prune", remote, `+refs/heads/main:refs/remotes/${remote}/main`]);
if (fetched.code !== 0) fail(`could not fetch ${remote}/main: ${fetched.stderr || fetched.stdout}`);

const head = mustGit(["rev-parse", "HEAD"], "could not read HEAD");
const tip = mustGit(["rev-parse", `${remote}/main`], `could not read ${remote}/main`);
if (head !== tip) {
  const ancestor = git(["merge-base", "--is-ancestor", "HEAD", `${remote}/main`]);
  if (ancestor.code !== 0) {
    fail(
      `local main is ahead of or diverged from ${remote}/main; ` +
        "integrate and push the worktree first",
    );
  }
  const dirty = git(["diff", "--name-only"]).stdout.split("\n").filter(Boolean);
  const incoming = git(["diff", "--name-only", "HEAD", `${remote}/main`])
    .stdout.split("\n")
    .filter(Boolean);
  const blocking = dirty.filter((path) => incoming.includes(path));
  if (blocking.length > 0) {
    fail(
      `uncommitted changes would block the fast-forward: ${blocking.join(", ")}. ` +
        "Keep those edits, apply the published revision, then rerun.",
    );
  }
  console.log(`publish: fast-forwarding main to ${tip.slice(0, 7)}`);
  const merged = git(["merge", "--ff-only", `${remote}/main`]);
  if (merged.code !== 0) fail(`could not fast-forward main: ${merged.stderr || merged.stdout}`);
} else {
  console.log(`publish: main is at ${head.slice(0, 7)}`);
}

console.log("publish: installing harness dependencies");
const install = run(["bun", "install", "--frozen-lockfile"]);
if (install.code !== 0) fail(`bun install failed: ${install.stderr || install.stdout}`);

console.log("publish: building the client bundle");
const built = run(["bun", "run", "build"]);
if (built.code !== 0) fail(`bun run build failed: ${built.stderr || built.stdout}`);

const distDir = join(harnessRoot, "dist");
const indexPath = join(distDir, "index.html");
if (!existsSync(indexPath)) fail("the build produced no dist/index.html");
const builtAt = statSync(indexPath).mtimeMs;
const sources = [
  join(harnessRoot, "client"),
  join(harnessRoot, "index.html"),
  join(harnessRoot, "vite.config.ts"),
  join(harnessRoot, "svelte.config.js"),
  join(harnessRoot, "package.json"),
  join(harnessRoot, "bun.lock"),
].filter((path) => existsSync(path));
const newestSource = Math.max(
  ...sources.map((path) =>
    statSync(path).isDirectory() ? walkNewest(path) : statSync(path).mtimeMs,
  ),
);
if (builtAt + 1000 < newestSource) {
  fail("dist/index.html is older than its sources; the bundle is stale");
}
const html = readFileSync(indexPath, "utf8");
for (const match of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
  const asset = join(distDir, match[1].slice(1));
  if (!existsSync(asset)) fail(`dist/index.html references a missing asset: ${asset}`);
}

const count = git(["rev-list", "--count", "HEAD"]);
if (count.code !== 0) fail("could not count commits");
const version = `0.1.${Number(count.stdout)}`;
const tag = `v${version}`;
console.log(`publish: waiting for the release workflow of ${head.slice(0, 7)} (${tag})`);

const deadline = Date.now() + waitTimeoutMs;
let workflow: { databaseId: number; status: string; conclusion: string | null } | undefined;
while (Date.now() < deadline) {
  const listed = run([
    "gh",
    "run",
    "list",
    "--workflow",
    "devboard-release.yml",
    "--branch",
    "main",
    "--limit",
    "30",
    "--json",
    "databaseId,headSha,status,conclusion",
  ]);
  if (listed.code === 0) {
    const runs = JSON.parse(listed.stdout) as Array<{
      databaseId: number;
      headSha: string;
      status: string;
      conclusion: string | null;
    }>;
    const match = runs.find((candidate) => candidate.headSha === head);
    if (match !== undefined) {
      workflow = match;
      if (match.status === "completed") break;
    }
  } else {
    fail(`could not list workflow runs: ${listed.stderr || listed.stdout}`);
  }
  await Bun.sleep(5000);
}

if (workflow === undefined) fail(`no devboard-release run for ${head.slice(0, 7)} within the wait`);
if (workflow.status !== "completed") fail("the release workflow did not complete within the wait");
if (workflow.conclusion !== "success") {
  fail(`the release workflow concluded ${workflow.conclusion ?? "unknown"}`);
}
console.log(`publish: release workflow ${workflow.databaseId} succeeded`);

let releaseOk = false;
let launcherOk = false;
while (Date.now() < deadline) {
  if (!releaseOk) {
    const release = run([
      "gh",
      "release",
      "view",
      tag,
      "--repo",
      RELEASE_REPO,
      "--json",
      "tagName,assets",
    ]);
    if (release.code === 0) {
      const assets = (JSON.parse(release.stdout) as { assets?: Array<{ name?: string }> }).assets ?? [];
      const names = new Set(assets.map((asset) => asset.name));
      releaseOk =
        names.has(`devboard-harness-${version}.tgz`) &&
        names.has(`devboard-harness-${version}.tgz.sha256`);
    }
  }
  if (!launcherOk) {
    const viewed = run(["npm", "view", `${LAUNCHER_PACKAGE}@${version}`, "version"]);
    launcherOk = viewed.code === 0 && viewed.stdout === version;
  }
  if (releaseOk && launcherOk) break;
  await Bun.sleep(5000);
}
if (!releaseOk) fail(`GitHub Release ${tag} is missing its harness tarball or checksum`);
if (!launcherOk) fail(`${LAUNCHER_PACKAGE}@${version} is not visible on npmjs`);

console.log(`publish: ${tag} carries the harness tarball and checksum`);
console.log(`publish: ${LAUNCHER_PACKAGE}@${version} is published`);

const inventory = dashboardInventory(discoverInstances());
for (const entry of inventory) console.log(describeInventory(entry));
console.log(`publish: ${inventory.length} dashboard(s) reported; no restart was requested`);
