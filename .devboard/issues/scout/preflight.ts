import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import {
  findOnPath,
  originForge,
  rootProblem,
} from "../repository";
import { configuredGiteaToken, giteaBaseUrl } from "../../lib/forge";
import { giteaRepository, type FetchLike } from "../../lib/gitea";
import { DEADLINE_EXPIRED, withinDeadline } from "../../lib/deadline";
import { ghCommand } from "../../server/command";

/**
 * Everything Start must prove before it spawns a scout: the checkout is the
 * canonical root of a GitHub origin, the state directory is inside it, the
 * agent tools exist, the scan command is installed, and the credential can
 * push. A refusal names the missing fact and spawns no peer and no scan.
 */

export type ScoutPreflightResult = { ok: true; repository: string } | { ok: false; message: string };

/** Default wall-clock bound for the whole start preflight. */
export const SCOUT_PREFLIGHT_TIMEOUT_MS = 20_000;

export interface ScoutPreflightOptions {
  repoDir: string;
  stateDir: string;
  environment?: Record<string, string | undefined>;
  /** Injected for tests; defaults to the operator's `gh`. */
  run?: (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** Injected transport for the Gitea API. */
  giteaFetch?: FetchLike;
  /** Whole-preflight deadline; defaults to `SCOUT_PREFLIGHT_TIMEOUT_MS`. */
  timeoutMs?: number;
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
  const timeoutMs = Math.max(1, options.timeoutMs ?? SCOUT_PREFLIGHT_TIMEOUT_MS);
  const root = rootProblem(options.repoDir);
  if (root !== undefined) return { ok: false, message: root };

  const remote = originForge(options.repoDir, environment);
  if (remote === undefined) {
    return { ok: false, message: "the checkout's origin does not name a supported repository" };
  }
  if (remote.forge === "gitlab") {
    return {
      ok: false,
      message: `the scout supports a GitHub or Gitea origin, not a GitLab one: ${remote.host}`,
    };
  }
  const repository = remote.project;

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
  if (remote.forge === "github" && findOnPath("gh", environment) === undefined) {
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

  if (remote.forge === "gitea") {
    const baseUrl = giteaBaseUrl(remote, environment);
    if (baseUrl === undefined) {
      return {
        ok: false,
        message:
          "missing prerequisite: the Gitea address is not configured " +
          "(set DEVBOARD_GITEA_URL or use an HTTP(S) origin)",
      };
    }
    const token = configuredGiteaToken(environment);
    if (token === undefined) {
      return { ok: false, message: "missing prerequisite: GITEA_TOKEN is not set" };
    }
    try {
      const document = await giteaRepository(
        { baseUrl, project: repository, token },
        options.giteaFetch,
      );
      const permissions =
        typeof document.permissions === "object" && document.permissions !== null
          ? document.permissions
          : {};
      const writable =
        ("push" in permissions && permissions.push === true) ||
        ("admin" in permissions && permissions.admin === true);
      if (!writable) {
        return {
          ok: false,
          message:
            `missing prerequisite: the Gitea token cannot write to ${repository} on ${baseUrl}`,
        };
      }
    } catch (error) {
      return {
        ok: false,
        message:
          `missing prerequisite: the Gitea repository ${repository} could not be read: ` +
          (error instanceof Error ? error.message : String(error)),
      };
    }
    return { ok: true, repository };
  }

  const execute =
    options.run ?? ((argv: string[]) => ghCommand(argv, environment, { timeoutMs }));
  const probe = ["api", `repos/${repository}`, "--jq", ".permissions.push"];
  const permission = await withinDeadline(Promise.resolve(execute(probe)), timeoutMs);
  if (permission === DEADLINE_EXPIRED) {
    return {
      ok: false,
      message:
        `missing prerequisite: 'gh api repos/${repository} --jq .permissions.push' ` +
        `did not finish within ${timeoutMs} ms`,
    };
  }
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
