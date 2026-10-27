import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import {
  findOnPath,
  isGitHubRemote,
  originRemoteUrl,
  originRepository,
  rootProblem,
} from "../repository";

/**
 * Everything Start must prove before it spawns a scout: the checkout is the
 * canonical root of a GitHub origin, the state directory is inside it, the
 * agent tools exist, the scan command is installed, and the credential can
 * push. A refusal names the missing fact and spawns no peer and no scan.
 */

export type ScoutPreflightResult = { ok: true; repository: string } | { ok: false; message: string };

export interface ScoutPreflightOptions {
  repoDir: string;
  stateDir: string;
  environment?: Record<string, string | undefined>;
  /** Injected for tests; defaults to the operator's `gh`. */
  run?: (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface ScoutCommandOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

export async function ghCommand(
  argv: string[],
  environment?: Record<string, string | undefined>,
): Promise<ScoutCommandOutcome> {
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
    return { code, stdout, stderr };
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

/** True when `stateDir` resolves inside `repoDir` (or is the root itself is refused). */
export function stateInsideRepository(repoDir: string, stateDir: string): boolean {
  const root = resolve(repoDir);
  const state = resolve(stateDir);
  const path = relative(root, state);
  if (path.length === 0) return false;
  return !path.startsWith("..") && !isAbsolute(path);
}

/**
 * The installed `/scout-recommendations` command, in the checkout first and
 * then the operator's omp command directories.
 */
export function scoutCommandPaths(
  repoDir: string,
  environment: Record<string, string | undefined> = process.env,
): string[] {
  const home = environment.HOME ?? homedir();
  return [
    join(resolve(repoDir), ".omp", "commands", "scout-recommendations.md"),
    join(home, ".omp", "commands", "scout-recommendations.md"),
    join(home, ".omp", "agent", "commands", "scout-recommendations.md"),
  ];
}

export async function preflightScout(options: ScoutPreflightOptions): Promise<ScoutPreflightResult> {
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

  if (!stateInsideRepository(options.repoDir, options.stateDir)) {
    return {
      ok: false,
      message:
        `STATE_DIR ${resolve(options.stateDir)} is not inside REPO_DIR ${resolve(options.repoDir)}; ` +
        "the scout keeps its state beside the checkout",
    };
  }

  if (findOnPath("omp", environment) === undefined) {
    return { ok: false, message: "missing prerequisite: omp is not on PATH" };
  }
  if (findOnPath("gh", environment) === undefined) {
    return { ok: false, message: "missing prerequisite: gh is not on PATH" };
  }

  const commandPaths = scoutCommandPaths(options.repoDir, environment);
  if (!commandPaths.some((path) => existsSync(path))) {
    return {
      ok: false,
      message:
        "missing prerequisite: the /scout-recommendations command is not installed for omp " +
        `(looked in ${commandPaths.join(", ")})`,
    };
  }

  const execute = options.run ?? ((argv: string[]) => ghCommand(argv, environment));
  const permission = await execute(["api", `repos/${repository}`, "--jq", ".permissions.push"]);
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
