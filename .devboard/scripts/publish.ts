#!/usr/bin/env bun
/**
 * Verifies a pushed `main` commit's release and reports the running
 * dashboards. The Gitea workflow builds, tests, publishes the launcher to
 * npmjs, and creates the harness release; this script waits for that run,
 * proves the release and launcher exist, pushes the GitHub mirror, and never
 * restarts a dashboard or writes into a host. A dashboard installs a new
 * harness itself and shows its reload control until an operator restarts it.
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { configuredGiteaToken, configuredGiteaUrl, parseForgeRemote } from "../lib/forge";
import { releaseVersionAt } from "../lib/commit-gate";
import { lowestReleaseVersion } from "../lib/release";
import {
  giteaDispatchWorkflow as dispatchWorkflow,
  giteaReleaseByTag,
  giteaWorkflowRuns,
  type GiteaTarget,
  type GiteaWorkflowRun,
} from "../lib/gitea";
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
const PACKAGE_NAME = "@dsdenes/devboard";

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

Waits for the Gitea release workflow of the pushed main commit, verifies the
private harness release and the public launcher version, pushes the GitHub
mirror, and reports every running dashboard's installed and running versions
without restarting it.

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

function run(argv: string[], cwd = harnessRoot, extraEnv: Record<string, string> = {}): CommandResult {
  const child = Bun.spawnSync({
    cmd: argv,
    cwd,
    env: {
      ...process.env,
      ...extraEnv,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      GIT_TERMINAL_PROMPT: "0",
    },
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

function giteaTarget(): GiteaTarget {
  let baseUrl = configuredGiteaUrl(process.env);
  if (baseUrl === undefined) {
    const origin = git(["remote", "get-url", "origin"]);
    if (origin.code === 0) baseUrl = parseForgeRemote(origin.stdout)?.originUrl;
  }
  if (baseUrl === undefined) {
    fail("the Gitea address is not configured; set DEVBOARD_GITEA_URL");
  }
  const token = configuredGiteaToken(process.env);
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    project: process.env.DEVBOARD_RELEASE_REPO ?? RELEASE_REPO,
    ...(token === undefined ? {} : { token }),
  };
}

const target = giteaTarget();

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

const published = mustGit(["rev-parse", "HEAD"], "could not read HEAD after the update");

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
  join(harnessRoot, "public"),
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

function workflowFinished(run: GiteaWorkflowRun): boolean {
  return (
    run.conclusion !== null ||
    ["completed", "success", "failure", "cancelled", "skipped", "timed_out"].includes(run.status)
  );
}

function chooseWorkflowRun(runs: readonly GiteaWorkflowRun[]): GiteaWorkflowRun | undefined {
  const matching = runs.filter((candidate) => candidate.headSha === published);
  return (
    matching.find((candidate) => !workflowFinished(candidate)) ??
    matching.find((candidate) => candidate.conclusion === "success") ??
    matching[0]
  );
}

/**
 * The release workflow is dispatch-only. Before waiting, dispatch it for the
 * checked-out `main` tip when that tip has no usable run: no run at all, or
 * only runs that already concluded unsuccessfully. A failed range therefore
 * gets one fresh attempt on the next train tick, while an active or successful
 * run is never duplicated.
 */
async function dispatchReleaseWhenNeeded(): Promise<{
  dispatched: boolean;
  previousIds: Set<number>;
}> {
  const runs = await giteaWorkflowRuns(target, published).catch((error: unknown) => {
    fail(`could not list workflow runs: ${error instanceof Error ? error.message : String(error)}`);
  });
  const matching = runs.filter((candidate) => candidate.headSha === published);
  const previousIds = new Set(matching.map((candidate) => candidate.id));
  if (matching.some((candidate) => !workflowFinished(candidate))) {
    return { dispatched: false, previousIds };
  }
  if (matching.some((candidate) => candidate.conclusion === "success")) {
    return { dispatched: false, previousIds };
  }
  try {
    await dispatchWorkflow(target, "devboard-release.yml", "refs/heads/main");
  } catch (error) {
    fail(
      `could not dispatch devboard-release.yml for ${published.slice(0, 7)}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  console.log(`publish: dispatched devboard-release.yml for ${published.slice(0, 7)}`);
  return { dispatched: true, previousIds };
}

console.log(`publish: waiting for the release workflow of ${published.slice(0, 7)}`);
const dispatchedRun = await dispatchReleaseWhenNeeded();

const deadline = Date.now() + waitTimeoutMs;
let workflow: GiteaWorkflowRun | undefined;
while (Date.now() < deadline) {
  const runs = await giteaWorkflowRuns(target, published).catch((error: unknown) => {
    fail(`could not list workflow runs: ${error instanceof Error ? error.message : String(error)}`);
  });
  // After a dispatch, only a run this invocation created can settle the wait;
  // the previous failed run must not be read as its answer.
  const candidates = dispatchedRun.dispatched
    ? runs.filter((candidate) => !dispatchedRun.previousIds.has(candidate.id))
    : runs;
  const match = chooseWorkflowRun(candidates);
  if (match !== undefined) {
    workflow = match;
    if (workflowFinished(match)) break;
  }
  await Bun.sleep(5000);
}

if (workflow === undefined) {
  fail(`no release workflow run for ${published.slice(0, 7)} within the wait`);
}
const concluded =
  workflow.conclusion ?? (workflow.status === "success" ? "success" : workflow.status);
if (concluded !== "success") {
  fail(`the release workflow concluded ${concluded === "" ? "no conclusion" : concluded}`);
}
console.log(`publish: release workflow ${workflow.id} succeeded`);

// The workflow's release step tags the published commit. Read the tag it
// created instead of recomputing a count locally: no release that reaches this
// commit means the release did not happen and publish must fail. Concurrent
// landings can publish a later commit first, so that release's tag contains
// this commit instead of naming it; either proves the change shipped.
function releaseVersionsContaining(commit: string): string[] {
  const result = git(["tag", "--contains", commit]);
  if (result.code !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => /^v([0-9]+\.[0-9]+\.[0-9]+)$/.exec(line.trim())?.[1])
    .filter((value): value is string => value !== undefined);
}

let version: string | undefined;
let containing = false;
let tagProblem: string | undefined;
const tagDeadline = Date.now() + waitTimeoutMs;
while (Date.now() < tagDeadline) {
  const fetchedTags = git(["fetch", "--tags", remote]);
  if (fetchedTags.code !== 0) {
    tagProblem = `could not fetch ${remote} tags: ${fetchedTags.stderr || fetchedTags.stdout}`;
  } else {
    tagProblem = undefined;
    version = releaseVersionAt(repoRoot, published);
    containing = false;
    if (version === undefined) {
      version = lowestReleaseVersion(releaseVersionsContaining(published));
      containing = version !== undefined;
    }
    if (version !== undefined) break;
  }
  await Bun.sleep(5000);
}
if (version === undefined) {
  fail(
    tagProblem ??
      `no release for ${published.slice(0, 7)} exists; the workflow published none`,
  );
}
const tag = `v${version}`;
console.log(
  containing
    ? `publish: release ${tag} includes ${published.slice(0, 7)}`
    : `publish: release ${tag} names ${published.slice(0, 7)}`,
);

let releaseOk = false;
let packageOk = false;
const verifyDeadline = Date.now() + waitTimeoutMs;
while (Date.now() < verifyDeadline) {
  if (!releaseOk) {
    const release = await giteaReleaseByTag(target, tag).catch(() => undefined);
    if (release !== undefined) {
      const names = new Set((release.assets ?? []).map((asset) => asset.name));
      releaseOk =
        names.has(`devboard-${version}.tgz`) &&
        names.has(`devboard-${version}.tgz.sha256`);
    }
  }
  if (!packageOk) {
    const viewed = run([
      "npm",
      "view",
      `${PACKAGE_NAME}@${version}`,
      "version",
      "--cache",
      join(harnessRoot, ".tmp", "npm-cache"),
      "--prefer-online",
    ]);
    packageOk = viewed.code === 0 && viewed.stdout === version;
  }
  if (releaseOk && packageOk) break;
  await Bun.sleep(5000);
}
if (!releaseOk) fail(`Gitea release ${tag} is missing its fallback tarball or checksum`);
if (!packageOk) fail(`${PACKAGE_NAME}@${version} is not visible on npmjs`);

console.log(`publish: ${tag} carries the fallback tarball and checksum`);
console.log(`publish: ${PACKAGE_NAME}@${version} is published`);

if (remotes.includes("github")) {
  // Another agent may merge and push while this run waits for its workflow.
  // The mirror carries the branch as it is now; the verified commit only has
  // to remain in its history.
  const mirrorHead = mustGit(["rev-parse", "HEAD"], "could not read HEAD before the mirror push");
  if (mirrorHead !== published) {
    const contains = git(["merge-base", "--is-ancestor", published, mirrorHead]);
    if (contains.code !== 0) {
      fail(`main no longer contains the published commit ${published.slice(0, 7)}`);
    }
    console.log(
      `publish: main advanced to ${mirrorHead.slice(0, 7)} after the release was verified`,
    );
  }
  console.log("publish: pushing the GitHub mirror");
  const mirrored = run(
    [
      "git",
      "-C",
      repoRoot,
      "-c",
      "credential.helper=",
      "-c",
      "credential.https://github.com.helper=!/usr/bin/gh auth git-credential",
      "push",
      "github",
      // Only the published branch and its tags: a stale local feature branch
      // in the integration checkout must not fail the release verification.
      "refs/heads/main:refs/heads/main",
      "refs/tags/*:refs/tags/*",
    ],
  );
  if (mirrored.code !== 0) {
    fail(`could not push the GitHub mirror: ${mirrored.stderr || mirrored.stdout}`);
  }
  const mirrorTip = git(["ls-remote", "github", "refs/heads/main"]);
  const mirrorSha = mirrorTip.stdout.split(/\s+/)[0] ?? "";
  const mirrorNames =
    mirrorSha === mirrorHead ||
    (mirrorSha.length > 0 &&
      git(["merge-base", "--is-ancestor", mirrorHead, mirrorSha]).code === 0);
  if (mirrorTip.code !== 0 || !mirrorNames) {
    fail(
      `the GitHub mirror main (${mirrorSha.slice(0, 7) || "missing"}) ` +
        `does not name ${mirrorHead.slice(0, 7)}`,
    );
  }
  console.log(
    mirrorHead === published
      ? `publish: github/main names ${published.slice(0, 7)}`
      : `publish: github/main names ${mirrorHead.slice(0, 7)} and contains ${published.slice(0, 7)}`,
  );
} else {
  console.log("publish: no github mirror remote; skipped");
}

const inventory = dashboardInventory(discoverInstances());
for (const entry of inventory) console.log(describeInventory(entry));
console.log(`publish: ${inventory.length} dashboard(s) reported; no restart was requested`);
