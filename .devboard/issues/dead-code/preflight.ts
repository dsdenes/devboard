import { existsSync } from "node:fs";
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
import { findOnPath, ompCommandPaths, originForge, rootProblem } from "../repository";
import type { ForgeRemote } from "../../lib/forge";
import { DEAD_CODE_LABEL, LABEL_COLOR, LABEL_DESCRIPTION } from "./paths";

/**
 * Everything Start proves before it spawns the Dead Code worker: the state
 * directory is inside the checkout, the origin is a supported forge with a
 * write-capable account, the `dead-code` label exists (created when missing),
 * the agent command is on PATH, and the `/dead-code-removal` command is
 * installed for it. A refusal names the missing fact and spawns nothing.
 */

export type DeadCodePreflightResult =
  | { ok: true; repository: string }
  | { ok: false; message: string };

export interface DeadCodePreflightOptions {
  repoDir: string;
  stateDir: string;
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
  const relativePath = relative(resolve(root), resolve(path));
  return relativePath.length > 0 && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

/** The installed `/dead-code-removal` command: checkout first, then the home. */
export function deadCodeCommandPaths(
  repoDir: string,
  environment: Record<string, string | undefined> = process.env,
): string[] {
  return ompCommandPaths(repoDir, environment).map((directory) =>
    join(directory, "dead-code-removal.md"),
  );
}

export async function preflightDeadCode(
  options: DeadCodePreflightOptions,
): Promise<DeadCodePreflightResult> {
  const environment = options.environment ?? process.env;
  const root = rootProblem(options.repoDir);
  if (root !== undefined) return { ok: false, message: root };

  if (!inside(options.repoDir, options.stateDir)) {
    return {
      ok: false,
      message:
        `STATE_DIR ${resolve(options.stateDir)} is not inside REPO_DIR ${resolve(options.repoDir)}; ` +
        "the dead-code worker keeps its state beside the checkout",
    };
  }

  const remote = options.origin ?? originForge(options.repoDir, environment);
  if (remote === undefined) {
    return { ok: false, message: "the checkout's origin does not name a supported repository" };
  }
  if (remote.forge === "gitlab") {
    return {
      ok: false,
      message: `the dead-code agent supports a GitHub or Gitea origin, not a GitLab one: ${remote.host}`,
    };
  }
  const repository = remote.project;

  if (findOnPath("omp", environment) === undefined) {
    return { ok: false, message: "missing prerequisite: omp is not on PATH" };
  }
  if (remote.forge === "github" && findOnPath("gh", environment) === undefined) {
    return { ok: false, message: "missing prerequisite: gh is not on PATH" };
  }

  const commandPaths = deadCodeCommandPaths(options.repoDir, environment);
  if (!commandPaths.some((path) => existsSync(path))) {
    return {
      ok: false,
      message:
        "missing prerequisite: the /dead-code-removal command is not installed for omp " +
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
      if (!labels.some((label) => label.name === DEAD_CODE_LABEL)) {
        try {
          await giteaCreateLabel(
            target,
            DEAD_CODE_LABEL,
            LABEL_COLOR,
            LABEL_DESCRIPTION,
            options.giteaFetch,
          );
        } catch (error) {
          // Another dashboard may have created it between the read and the write.
          const after = await giteaLabels(target, options.giteaFetch);
          if (!after.some((label) => label.name === DEAD_CODE_LABEL)) {
            const detail = error instanceof GiteaError ? error.message : String(error);
            return {
              ok: false,
              message:
                `missing prerequisite: the "${DEAD_CODE_LABEL}" label could not be created in ` +
                `${repository}: ${detail}`,
            };
          }
        }
      }
    } catch (error) {
      const detail = error instanceof GiteaError ? error.message : String(error);
      return {
        ok: false,
        message: `missing prerequisite: the Gitea repository ${repository} could not be read: ${detail}`,
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
    `repos/${repository}/labels/${DEAD_CODE_LABEL}`,
    "--jq",
    ".name",
  ]);
  if (label.code !== 0 || label.stdout.trim() !== DEAD_CODE_LABEL) {
    const created = await execute([
      "label",
      "create",
      DEAD_CODE_LABEL,
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
          `missing prerequisite: the "${DEAD_CODE_LABEL}" label could not be created in ` +
          `${repository}: ${firstLine(created.stderr) ?? `gh exited with code ${created.code}`}`,
      };
    }
  }
  return { ok: true, repository };
}
