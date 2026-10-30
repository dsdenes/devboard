import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { giteaBaseUrl, configuredGiteaToken, type Forge } from "../../lib/forge";
import { deriveReleaseVersion } from "../../lib/commit-gate";
import { giteaWorkflowRuns } from "../../lib/gitea";
import { originForge } from "../repository";
import { findOnPath } from "../repository";
import { runCommand } from "../scout/preflight";
import { type DesignConfig, cycleBranch, worktreesRoot } from "./paths";
import { missingPrincipleSections, validTokenDocument } from "./scan";

/**
 * The autonomous documentation release path: one cycle worktree, one commit
 * limited to the two documents, integration of main, a non-force push, the
 * release workflow wait, the integration checkout's fast-forward, and
 * `bun run publish`. Every external step is injectable so the planner can be
 * proven without a real forge, npm, or Gitea.
 */

export interface CommandOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunCommand {
  (argv: string[], options: { cwd?: string; env?: Record<string, string | undefined> }): Promise<CommandOutcome>;
}

export interface ReleaseInput {
  repoDir: string;
  harnessDir: string;
  cycleId: string;
  summary: string;
  config: DesignConfig;
  /** Repository-relative documents already written by the peer's draft. */
  documents: Array<{ path: string; text: string }>;
  environment: Record<string, string | undefined>;
  activity: (line: string) => void;
  now: () => Date;
  /** Injected for tests. Defaults to the bounded Git and publish path. */
  run?: RunCommand;
  checks?: (worktree: string) => Promise<{ ok: true } | { ok: false; detail: string }>;
  waitForWorkflow?: (options: {
    sha: string;
    repoDir: string;
    environment: Record<string, string | undefined>;
  }) => Promise<{ ok: true } | { ok: false; detail: string }>;
  publish?: (options: {
    sha: string;
    version: string;
    tag: string;
    harnessDir: string;
    environment: Record<string, string | undefined>;
  }) => Promise<{ ok: true } | { ok: false; detail: string }>;
  /** How many rejected pushes are integrated and retried. */
  pushAttempts?: number;
}

export type ReleaseResult =
  | {
      ok: true;
      version: string;
      url: string;
      sha: string;
      branch: string;
      /** The repository-relative documents the released commit changed. */
      files: string[];
      /** The unified diff of exactly those documents, as committed. */
      diff: string;
    }
  | { ok: false; detail: string; step: string };

const PUSH_ATTEMPTS = 3;
const FETCH_LIMIT_MS = 10 * 60_000;
const WORKFLOW_TIMEOUT_MS = 30 * 60_000;
const PUBLISH_TIMEOUT_MS = 60 * 60_000;

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "no diagnostic"
  );
}

function boundedEnv(
  environment: Record<string, string | undefined>,
  extra: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) merged[key] = value;
  }
  return { ...merged, ...extra, GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" };
}

const defaultRun: RunCommand = async (argv, options) => {
  const result = await runCommand(
    argv,
    options.env ?? process.env,
    options.cwd === undefined
      ? {}
      : { cwd: options.cwd, timeoutMs: Math.max(1, FETCH_LIMIT_MS) },
  );
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
};

export interface GitRunner {
  (cwd: string, args: string[], extraEnv?: Record<string, string>): Promise<CommandOutcome>;
}

function makeGit(run: RunCommand, environment: Record<string, string | undefined>): GitRunner {
  return async function git(
    cwd: string,
    args: string[],
    extraEnv: Record<string, string> = {},
  ): Promise<CommandOutcome> {
    return await run(["git", "-C", cwd, ...args], {
      cwd,
      env: boundedEnv(environment, extraEnv),
    });
  };
}

function must(outcome: CommandOutcome, description: string): string {
  if (outcome.code !== 0) {
    throw new Error(`${description}: ${firstLine(outcome.stderr) || firstLine(outcome.stdout)}`);
  }
  return outcome.stdout.trim();
}

function releaseUrl(
  repoDir: string,
  environment: Record<string, string | undefined>,
  project: string,
  tag: string,
): string {
  const remote = originForge(repoDir, environment);
  if (remote?.forge === "gitea") {
    const baseUrl = giteaBaseUrl(remote, environment);
    if (baseUrl !== undefined) return `${baseUrl.replace(/\/+$/, "")}/${project}/releases/tag/${tag}`;
  }
  if (remote?.forge === "github") return `https://github.com/${project}/releases/tag/${tag}`;
  return `${project}/releases/tag/${tag}`;
}

async function defaultChecks(
  worktree: string,
  config: DesignConfig,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const designPath = join(worktree, config.designDocument);
  if (!existsSync(designPath)) return { ok: false, detail: `${config.designDocument} is missing` };
  const prose = readFileSync(designPath, "utf8");
  const missing = missingPrincipleSections(prose);
  if (missing.length > 0) {
    return { ok: false, detail: `the documentation lacks ${missing.join(" and ")}` };
  }
  const tokenPath = join(worktree, config.tokenDocument);
  if (!existsSync(tokenPath)) return { ok: false, detail: `${config.tokenDocument} is missing` };
  if (!validTokenDocument(readFileSync(tokenPath, "utf8"))) {
    return { ok: false, detail: `${config.tokenDocument} is not a JSON object` };
  }
  return { ok: true };
}

async function defaultWaitForWorkflow(options: {
  sha: string;
  repoDir: string;
  environment: Record<string, string | undefined>;
}): Promise<{ ok: true } | { ok: false; detail: string }> {
  const remote = originForge(options.repoDir, options.environment);
  if (remote === undefined) return { ok: false, detail: "the origin is not a supported forge" };
  if (remote.forge !== "gitea") {
    return {
      ok: false,
      detail: "waiting for the release workflow needs a Gitea origin",
    };
  }
  const baseUrl = giteaBaseUrl(remote, options.environment);
  if (baseUrl === undefined) {
    return { ok: false, detail: "the Gitea address is not configured" };
  }
  const token = configuredGiteaToken(options.environment);
  const target = {
    baseUrl,
    project: remote.project,
    ...(token === undefined ? {} : { token }),
  };
  const timeout = Number(options.environment.DESIGN_WORKFLOW_TIMEOUT_MS ?? "");
  const deadline =
    Date.now() + (Number.isFinite(timeout) && timeout > 0 ? timeout : WORKFLOW_TIMEOUT_MS);
  while (Date.now() < deadline) {
    try {
      const runs = await giteaWorkflowRuns(target, options.sha);
      const match = runs.find((candidate) => candidate.headSha === options.sha);
      if (match !== undefined) {
        const concluded =
          match.conclusion ?? (match.status === "success" ? "success" : null);
        if (concluded !== null && concluded !== "") {
          return concluded === "success"
            ? { ok: true }
            : { ok: false, detail: `the release workflow concluded ${concluded}` };
        }
      }
    } catch (error) {
      // A transient read is retried until the deadline.
    }
    await Bun.sleep(1000);
  }
  return { ok: false, detail: "the release workflow did not conclude before the wait" };
}

async function defaultPublish(options: {
  sha: string;
  version: string;
  tag: string;
  harnessDir: string;
  environment: Record<string, string | undefined>;
}): Promise<{ ok: true } | { ok: false; detail: string }> {
  const bun = findOnPath("bun", options.environment) ?? "bun";
  const configured = options.environment.DESIGN_PUBLISH_COMMAND?.trim();
  const argv =
    configured === undefined || configured.length === 0
      ? [bun, "run", "publish"]
      : [configured];
  const outcome = await runCommand(argv, boundedEnv(options.environment, {
    DESIGN_RELEASE_VERSION: options.version,
    DESIGN_RELEASE_TAG: options.tag,
    DESIGN_RELEASE_COMMIT: options.sha,
  }), {
    cwd: options.harnessDir,
    timeoutMs: Math.max(
      1,
      Number(options.environment.DESIGN_PUBLISH_TIMEOUT_MS ?? PUBLISH_TIMEOUT_MS) || PUBLISH_TIMEOUT_MS,
    ),
  });
  if (outcome.code !== 0) {
    return {
      ok: false,
      detail: `bun run publish exited ${outcome.code}: ${
        firstLine(outcome.stderr) || firstLine(outcome.stdout)
      }`,
    };
  }
  return { ok: true };
}

interface Worktree {
  directory: string;
  branch: string;
}

async function removeWorktree(
  repoDir: string,
  worktree: Worktree,
  git: GitRunner,
): Promise<void> {
  if (existsSync(worktree.directory)) {
    await git(worktree.directory, ["worktree", "remove", "--force", worktree.directory]);
    if (existsSync(worktree.directory)) {
      try {
        rmSync(worktree.directory, { recursive: true, force: true });
      } catch {
        // The branch cleanup below still preserves the commit.
      }
    }
  }
  await git(repoDir, ["worktree", "prune"]);
  await git(repoDir, ["branch", "-D", worktree.branch]);
}

async function ensureWorktree(
  repoDir: string,
  cycleId: string,
  git: GitRunner,
): Promise<Worktree> {
  mkdirSync(worktreesRoot(repoDir), { recursive: true });
  const directory = join(worktreesRoot(repoDir), `design-${cycleId}`);
  const branch = cycleBranch(cycleId);
  if (existsSync(directory)) {
    throw new Error(`the cycle worktree already exists: ${directory}`);
  }
  const remote = await git(repoDir, ["rev-parse", "--verify", "--quiet", "origin/main"]);
  const base = remote.code === 0 ? "origin/main" : "main";
  const added = await git(repoDir, ["worktree", "add", "-b", branch, directory, base]);
  if (added.code !== 0) {
    // A failed add can leave a partial directory and branch behind; discard
    // only what this attempt created, never a pre-existing worktree.
    if (existsSync(directory)) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // The prune and branch deletion below still run.
      }
    }
    await git(repoDir, ["worktree", "prune"]);
    await git(repoDir, ["branch", "-D", branch]);
    throw new Error(
      `could not create the cycle worktree from ${base}: ` +
        (firstLine(added.stderr) || firstLine(added.stdout)),
    );
  }
  return { directory, branch };
}

/**
 * One documentation release. A no-op is a caller decision: this function is
 * invoked only when the cycle has an admissible document change.
 */
export async function releaseDocuments(input: ReleaseInput): Promise<ReleaseResult> {
  const run = input.run ?? defaultRun;
  const git = makeGit(run, input.environment);
  const checks = input.checks ?? ((worktree) => defaultChecks(worktree, input.config));
  const waitForWorkflow = input.waitForWorkflow ?? defaultWaitForWorkflow;
  const publish = input.publish ?? defaultPublish;
  const project = originForge(input.repoDir, input.environment)?.project ?? "";
  let pushed = false;
  let worktree: Worktree | undefined;
  try {
    worktree = await ensureWorktree(input.repoDir, input.cycleId, git);
    input.activity(`documentation: ${input.summary}`);
    for (const document of input.documents) {
      const target = join(worktree.directory, document.path);
      mkdirSync(resolve(target, ".."), { recursive: true });
      writeFileSync(target, document.text);
      const written = readFileSync(target, "utf8");
      if (written !== document.text) {
        throw new Error(`could not apply ${document.path} to the cycle worktree`);
      }
    }
    const paths = input.documents.map((document) => document.path);
    const status = await git(worktree.directory, ["status", "--porcelain", "--untracked-files=no"]);
    must(status, "could not read the cycle worktree status");
    const changed = status.stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/).slice(1).join(" "))
      .filter((path) => path.length > 0);
    if (changed.length === 0) {
      throw new Error("the admissible decision produced no document change");
    }
    if (changed.some((path) => !paths.includes(path))) {
      throw new Error(`the cycle changed a file outside the two documents: ${changed.join(", ")}`);
    }
    must(await git(worktree.directory, ["add", "--", ...paths]), "could not stage the documents");
    const committed = await git(worktree.directory, [
      "commit",
      "-m",
      `docs(design): ${input.summary.trim()}`.slice(0, 72).trimEnd(),
    ]);
    must(committed, "could not commit the documentation change");
    input.activity(`documentation committed on ${worktree.branch}`);
    const releasedDiff = must(
      await git(worktree.directory, ["diff", "--no-color", "HEAD^", "HEAD", "--", ...paths]),
      "could not read the documentation diff",
    );

    const check = await checks(worktree.directory);
    if (!check.ok) throw new Error(`the documentation check failed: ${check.detail}`);

    const fetched = await git(worktree.directory, ["fetch", "origin", "main"]);
    must(fetched, "could not fetch origin/main");
    const merged = await git(worktree.directory, ["merge", "--no-edit", "origin/main"]);
    if (merged.code !== 0) {
      const conflicts = await git(worktree.directory, [
        "diff",
        "--name-only",
        "--diff-filter=U",
      ]);
      const conflicted = conflicts.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
      if (conflicted.length === 0) throw new Error(`could not integrate main: ${firstLine(merged.stderr)}`);
      for (const path of conflicted) {
        if (!paths.includes(path)) {
          throw new Error(`a conflict outside the two documents blocks the cycle: ${path}`);
        }
        must(await git(worktree.directory, ["checkout", "--ours", "--", path]), `could not resolve ${path}`);
        must(await git(worktree.directory, ["add", "--", path]), `could not stage ${path}`);
        input.activity(`resolved the conflict in ${path} with the cycle's accepted standard`);
      }
      must(
        await git(worktree.directory, ["commit", "--no-edit"]),
        "could not commit the conflict resolution",
      );
    }
    const resolvedCheck = await checks(worktree.directory);
    if (!resolvedCheck.ok) {
      throw new Error(`the integrated documentation check failed: ${resolvedCheck.detail}`);
    }
    const allowed = new Set(paths);
    const diff = await git(worktree.directory, ["diff", "--name-only", "origin/main...HEAD"]);
    const outside = diff.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((path) => path.length > 0 && !allowed.has(path));
    if (outside.length > 0) {
      throw new Error(`the cycle diff touches files outside the two documents: ${outside.join(", ")}`);
    }

    const attempts = Math.max(1, input.pushAttempts ?? PUSH_ATTEMPTS);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const push = await git(worktree.directory, ["push", "origin", "HEAD:main"]);
      if (push.code === 0) {
        pushed = true;
        break;
      }
      const diagnostic = `${push.stderr}\n${push.stdout}`.toLowerCase();
      const rejected =
        diagnostic.includes("rejected") ||
        diagnostic.includes("non-fast-forward") ||
        diagnostic.includes("fetch first");
      if (!rejected) {
        throw new Error(`could not push main: ${firstLine(push.stderr) || firstLine(push.stdout)}`);
      }
      input.activity(`push rejected; integrating origin/main and retrying (attempt ${attempt})`);
      must(await git(worktree.directory, ["fetch", "origin", "main"]), "could not fetch after a rejected push");
      const retry = await git(worktree.directory, ["merge", "--no-edit", "origin/main"]);
      if (retry.code !== 0) {
        const conflicts = await git(worktree.directory, ["diff", "--name-only", "--diff-filter=U"]);
        for (const path of conflicts.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
          if (!paths.includes(path)) throw new Error(`a conflict outside the documents blocks the retry: ${path}`);
          must(await git(worktree.directory, ["checkout", "--ours", "--", path]), `could not resolve ${path}`);
          must(await git(worktree.directory, ["add", "--", path]), `could not stage ${path}`);
          input.activity(`resolved the retry conflict in ${path} with the cycle's accepted standard`);
        }
        must(await git(worktree.directory, ["commit", "--no-edit"]), "could not commit the retry resolution");
      }
      const recheck = await checks(worktree.directory);
      if (!recheck.ok) throw new Error(`the retry check failed: ${recheck.detail}`);
    }
    if (!pushed) throw new Error("main rejected every push attempt");

    const sha = must(await git(worktree.directory, ["rev-parse", "HEAD"]), "could not read the pushed commit");
    input.activity(`pushed ${sha.slice(0, 7)} to main`);

    const workflow = await waitForWorkflow({
      sha,
      repoDir: input.repoDir,
      environment: input.environment,
    });
    if (!workflow.ok) throw new Error(workflow.detail);
    input.activity(`release workflow for ${sha.slice(0, 7)} succeeded`);

    const fetchedIntegration = await git(input.repoDir, ["fetch", "origin", "main"]);
    must(fetchedIntegration, "could not fetch origin/main in the integration checkout");
    const fetchedTags = await git(input.repoDir, ["fetch", "--tags", "origin"]);
    must(fetchedTags, "could not fetch origin release tags");
    const incoming = await git(input.repoDir, ["diff", "--name-only", "HEAD", "origin/main"]);
    const incomingPaths = incoming.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    const dirty = await git(input.repoDir, ["status", "--porcelain", "--untracked-files=no"]);
    const dirtyPaths = dirty.stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/).slice(1).join(" "))
      .filter(Boolean);
    const blocking = dirtyPaths.filter((path) => incomingPaths.includes(path));
    if (blocking.length > 0) {
      throw new Error(
        `uncommitted changes in the integration checkout block the fast-forward: ${blocking.join(", ")}`,
      );
    }
    const ahead = must(await git(input.repoDir, ["rev-parse", "HEAD"]), "could not read the integration HEAD");
    if (ahead !== sha) {
      const fastForward = await git(input.repoDir, ["merge", "--ff-only", "origin/main"]);
      if (fastForward.code !== 0) {
        throw new Error(
          `the integration checkout cannot fast-forward to origin/main without discarding work: ` +
            firstLine(fastForward.stderr),
        );
      }
    }
    const contains = await git(input.repoDir, ["merge-base", "--is-ancestor", sha, "HEAD"]);
    if (contains.code !== 0) {
      throw new Error("the integration checkout does not contain the pushed commit");
    }

    const version = deriveReleaseVersion(input.repoDir, sha).version;
    const tag = `v${version}`;
    input.activity(`publishing ${version} from the integration checkout`);
    const published = await publish({
      sha,
      version,
      tag,
      harnessDir: input.harnessDir,
      environment: input.environment,
    });
    if (!published.ok) throw new Error(published.detail);
    const url = releaseUrl(input.repoDir, input.environment, project, tag);
    input.activity(`released ${tag}: ${url}`);
    await removeWorktree(input.repoDir, worktree, git);
    return { ok: true, version, url, sha, branch: worktree.branch, files: [...changed].sort(), diff: releasedDiff };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (pushed && worktree !== undefined) {
      // The commit stays on main; the local worktree adds nothing and the
      // branch is already merged into the pushed history.
      try {
        await removeWorktree(input.repoDir, worktree, git);
      } catch {
        // Cleanup is best effort; the pushed commit is the outcome.
      }
    }
    return { ok: false, detail, step: pushed ? "release" : "documentation" };
  }
}
