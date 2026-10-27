import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  findOnPath,
  isGitHubRemote,
  ompCommandPaths,
  ompExtensionPaths,
  originRemoteUrl,
  originRepository,
  rootProblem,
} from "./repository";
import { legacyLiveLock, legacyLockRefusal } from "./legacy";
import type { GhOutcome } from "./tracker";

/**
 * Everything Start must prove before it spawns a worker: the checkout is the
 * canonical root of a GitHub origin, the agent tools exist, the command is
 * installed, the credential can push, and no legacy orchestrator still owns
 * the tracker. A refusal names the missing fact and writes no ACP peer.
 */

export type PreflightResult = { ok: true; repository: string } | { ok: false; message: string };

export interface PreflightOptions {
  repoDir: string;
  stateDir: string;
  environment?: Record<string, string | undefined>;
  /** Injected for tests; defaults to the operator's `gh`. */
  run?: (argv: string[]) => GhOutcome | Promise<GhOutcome>;
}

async function gh(argv: string[], environment?: Record<string, string | undefined>): Promise<GhOutcome> {
  try {
    const child = Bun.spawn({
      cmd: ["gh", ...argv],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...(environment ?? process.env),
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
        GIT_TERMINAL_PROMPT: "0",
        NO_COLOR: "1",
      },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    return { code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}

function firstLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

export async function preflightIssues(options: PreflightOptions): Promise<PreflightResult> {
  const environment = options.environment ?? process.env;
  const root = rootProblem(options.repoDir);
  if (root !== undefined) return { ok: false, message: root };

  const remote = originRemoteUrl(options.repoDir);
  const repository = originRepository(options.repoDir);
  if (remote === undefined || repository === undefined) {
    return { ok: false, message: "the checkout's origin does not name a GitHub repository" };
  }
  if (!isGitHubRemote(remote)) {
    return { ok: false, message: `the checkout's origin is not a GitHub repository: ${remote}` };
  }

  const legacy = legacyLiveLock(options.stateDir);
  if (legacy !== undefined) {
    return { ok: false, message: legacyLockRefusal(legacy, options.stateDir) };
  }

  if (findOnPath("omp", environment) === undefined) {
    return { ok: false, message: "missing prerequisite: omp is not on PATH" };
  }
  if (findOnPath("gh", environment) === undefined) {
    return { ok: false, message: "missing prerequisite: gh is not on PATH" };
  }

  const commands = ompCommandPaths(options.repoDir, environment).map((directory) =>
    join(directory, "implement-issue.md"),
  );
  if (!commands.some((path) => existsSync(path))) {
    return {
      ok: false,
      message:
        "missing prerequisite: the /implement-issue command is not installed for omp " +
        `(looked in ${commands.join(", ")}); install the harness wrappers with .devboard/install.sh`,
    };
  }

  const extensions = ompExtensionPaths(options.repoDir, environment).map((directory) =>
    join(directory, "implement-goal-issue.ts"),
  );
  if (!extensions.some((path) => existsSync(path))) {
    return {
      ok: false,
      message:
        "missing prerequisite: the /implement-goal-issue extension is not installed for omp " +
        `(looked in ${extensions.join(", ")}); install the harness wrappers with .devboard/install.sh`,
    };
  }

  const execute = options.run ?? ((argv: string[]) => gh(argv, environment));
  const permission = await execute([
    "api",
    `repos/${repository}`,
    "--jq",
    ".permissions.push",
  ]);
  if (permission.code !== 0 || permission.stdout.trim() !== "true") {
    const detail =
      firstLine(permission.stderr) ??
      firstLine(permission.stdout) ??
      `gh exited with code ${permission.code}`;
    return {
      ok: false,
      message:
        `missing prerequisite: 'gh api repos/${repository} --jq .permissions.push' ` +
        `did not return true: ${detail}`,
    };
  }

  return { ok: true, repository };
}
