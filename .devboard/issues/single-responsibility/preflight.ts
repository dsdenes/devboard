import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { configuredGiteaToken, giteaBaseUrl } from "../../lib/forge";
import {
  GiteaError,
  giteaCreateLabel,
  giteaLabels,
  giteaRepository,
  type FetchLike,
} from "../../lib/gitea";
import { ghCommand } from "../../server/command";
import { findOnPath, originForge, rootProblem } from "../repository";
import type { ForgeRemote } from "../../lib/forge";
import {
  LABEL_COLOR,
  LABEL_DESCRIPTION,
  SINGLE_RESPONSIBILITY_LABEL,
  singleResponsibilityConfig,
  type SingleResponsibilityConfig,
} from "./paths";
import { readSkillDirectives } from "./provenance";

/**
 * Everything Start proves before it spawns the Single Responsibility worker:
 * the checkout is the canonical source tree, the managed skill is readable and
 * inside the repository, the state directory is inside the checkout, the
 * origin is a supported forge with a write-capable account, the
 * `single-responsibility` label exists (created when missing), the agent
 * command is on PATH, and the `/single-responsibility` command is installed
 * for it. A refusal names the missing fact, spawns no worker, and writes no
 * state.
 */

export type SingleResponsibilityPreflightResult =
  | { ok: true; repository: string }
  | { ok: false; message: string };

export interface SingleResponsibilityPreflightOptions {
  repoDir: string;
  stateDir: string;
  config?: SingleResponsibilityConfig;
  environment?: Record<string, string | undefined>;
  /** Injected for tests; defaults to the operator's `gh`. */
  run?: (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** Injected transport for the Gitea API. */
  giteaFetch?: FetchLike;
  /** Injected for tests that cannot leave a forge-shaped remote readable. */
  origin?: ForgeRemote;
}

function firstLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

function inside(root: string, path: string): boolean {
  const local = relative(resolve(root), resolve(path));
  return local.length === 0 || (!local.startsWith("..") && !isAbsolute(local));
}

/** The installed `/single-responsibility` command: checkout first, then the home. */
export function singleResponsibilityCommandPaths(
  repoDir: string,
  environment: Record<string, string | undefined> = process.env,
): string[] {
  const home = environment.HOME ?? homedir();
  return [
    join(resolve(repoDir), ".omp", "commands", "single-responsibility.md"),
    join(home, ".omp", "commands", "single-responsibility.md"),
    join(home, ".omp", "agent", "commands", "single-responsibility.md"),
  ];
}

export async function preflightSingleResponsibility(
  options: SingleResponsibilityPreflightOptions,
): Promise<SingleResponsibilityPreflightResult> {
  const environment = options.environment ?? process.env;
  const config = options.config ?? singleResponsibilityConfig();
  const root = rootProblem(options.repoDir);
  if (root !== undefined) return { ok: false, message: root };

  const repoReal = (() => {
    try {
      return realpathSync(resolve(options.repoDir));
    } catch {
      return resolve(options.repoDir);
    }
  })();
  const skillPath = join(resolve(options.repoDir), config.skillDocument);
  let skillStat;
  try {
    skillStat = lstatSync(skillPath);
  } catch {
    return {
      ok: false,
      message: `missing prerequisite: the skill ${config.skillDocument} is not readable`,
    };
  }
  let skillReal: string;
  try {
    skillReal = realpathSync(skillPath);
  } catch {
    return {
      ok: false,
      message: `missing prerequisite: the skill ${config.skillDocument} is not readable`,
    };
  }
  if (!inside(repoReal, skillReal)) {
    return {
      ok: false,
      message: `missing prerequisite: the skill ${config.skillDocument} resolves outside the repository`,
    };
  }
  if (!skillStat.isFile() || skillStat.isSymbolicLink()) {
    return {
      ok: false,
      message: `missing prerequisite: the skill ${config.skillDocument} is not a regular file`,
    };
  }
  try {
    readSkillDirectives(options.repoDir, config.skillDocument);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `missing prerequisite: the skill is unusable: ${detail}` };
  }

  if (!inside(options.repoDir, options.stateDir)) {
    return {
      ok: false,
      message:
        `STATE_DIR ${resolve(options.stateDir)} is not inside REPO_DIR ${resolve(options.repoDir)}; ` +
        "the single-responsibility worker keeps its state beside the checkout",
    };
  }

  const remote = options.origin ?? originForge(options.repoDir, environment);
  if (remote === undefined) {
    return { ok: false, message: "the checkout's origin does not name a supported repository" };
  }
  if (remote.forge === "gitlab") {
    return {
      ok: false,
      message:
        `the Single Responsibility agent supports a GitHub or Gitea origin, not a GitLab one: ` +
        remote.host,
    };
  }
  const repository = remote.project;

  if (findOnPath("omp", environment) === undefined) {
    return { ok: false, message: "missing prerequisite: omp is not on PATH" };
  }
  if (remote.forge === "github" && findOnPath("gh", environment) === undefined) {
    return { ok: false, message: "missing prerequisite: gh is not on PATH" };
  }

  const commandPaths = singleResponsibilityCommandPaths(options.repoDir, environment);
  if (!commandPaths.some((path) => existsSync(path))) {
    return {
      ok: false,
      message:
        "missing prerequisite: the /single-responsibility command is not installed for omp " +
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
      const target = { baseUrl, project: repository, token };
      const labels = await giteaLabels(target, options.giteaFetch);
      if (!labels.some((label) => label.name === SINGLE_RESPONSIBILITY_LABEL)) {
        try {
          await giteaCreateLabel(
            target,
            SINGLE_RESPONSIBILITY_LABEL,
            LABEL_COLOR,
            LABEL_DESCRIPTION,
            options.giteaFetch,
          );
        } catch (error) {
          // Another dashboard may have created it between the read and the write.
          const after = await giteaLabels(target, options.giteaFetch);
          if (!after.some((label) => label.name === SINGLE_RESPONSIBILITY_LABEL)) {
            const detail = error instanceof GiteaError ? error.message : String(error);
            return {
              ok: false,
              message:
                `missing prerequisite: the "${SINGLE_RESPONSIBILITY_LABEL}" label could not be ` +
                `created in ${repository}: ${detail}`,
            };
          }
        }
      }
    } catch (error) {
      const detail = error instanceof GiteaError ? error.message : String(error);
      return {
        ok: false,
        message:
          `missing prerequisite: the Gitea repository ${repository} could not be read: ${detail}`,
      };
    }
    return { ok: true, repository };
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
  const label = await execute([
    "api",
    `repos/${repository}/labels/${SINGLE_RESPONSIBILITY_LABEL}`,
    "--jq",
    ".name",
  ]);
  if (label.code !== 0 || label.stdout.trim() !== SINGLE_RESPONSIBILITY_LABEL) {
    const created = await execute([
      "label",
      "create",
      SINGLE_RESPONSIBILITY_LABEL,
      "--repo",
      repository,
      "--color",
      LABEL_COLOR,
      "--description",
      LABEL_DESCRIPTION,
      "--force",
    ]);
    if (created.code !== 0) {
      return {
        ok: false,
        message:
          `missing prerequisite: the "${SINGLE_RESPONSIBILITY_LABEL}" label could not be created ` +
          `in ${repository}: ${
            firstLine(created.stderr) ?? `gh exited with code ${created.code}`
          }`,
      };
    }
  }
  return { ok: true, repository };
}
