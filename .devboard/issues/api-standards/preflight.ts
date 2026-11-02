import { existsSync, lstatSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { configuredGiteaToken, giteaBaseUrl } from "../../lib/forge";
import {
  GiteaError,
  giteaCreateLabel,
  giteaLabels,
  giteaRepository,
  type FetchLike,
} from "../../lib/gitea";
import { ghCommand } from "../scout/preflight";
import { originForge } from "../repository";
import type { ForgeRemote } from "../../lib/forge";
import { ApiStandardsInputError, readRestSkill } from "./rules";
import {
  API_STANDARDS_LABEL,
  LABEL_COLOR,
  LABEL_DESCRIPTION,
  apiStandardsConfig,
  type ApiStandardsConfig,
} from "./paths";

/**
 * Everything Start proves before it spawns the API Standards worker: the
 * canonical source checkout carries the API source directory, both REST skill
 * files are readable and the rule table is non-empty, the origin is a supported
 * forge with a write-capable account, and the `api-standards` label is present
 * (created when the repository lacks it). A refusal names the missing fact,
 * spawns no worker, and writes no state.
 */

export type ApiStandardsPreflightResult =
  | { ok: true; repository: string }
  | { ok: false; message: string };

export interface ApiStandardsPreflightOptions {
  repoDir: string;
  stateDir: string;
  config?: ApiStandardsConfig;
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

export async function preflightApiStandards(
  options: ApiStandardsPreflightOptions,
): Promise<ApiStandardsPreflightResult> {
  const environment = options.environment ?? process.env;
  const config = options.config ?? apiStandardsConfig();
  const root = resolve(options.repoDir);

  const sourceRoot = join(root, config.sourceDir);
  if (!existsSync(sourceRoot)) {
    return {
      ok: false,
      message:
        `missing prerequisite: the canonical harness source checkout has no ` +
        `${config.sourceDir} directory (an installed npm prefix is refused)`,
    };
  }
  let sourceStat;
  try {
    sourceStat = lstatSync(sourceRoot);
  } catch {
    return { ok: false, message: `missing prerequisite: ${config.sourceDir} is not readable` };
  }
  if (!sourceStat.isDirectory()) {
    return { ok: false, message: `missing prerequisite: ${config.sourceDir} is not a directory` };
  }

  try {
    readRestSkill(root, config);
  } catch (error) {
    const detail = error instanceof ApiStandardsInputError ? error.message : String(error);
    return {
      ok: false,
      message: `missing prerequisite: the REST skill is unusable: ${detail}`,
    };
  }

  if (!inside(options.repoDir, options.stateDir)) {
    return {
      ok: false,
      message:
        `STATE_DIR ${resolve(options.stateDir)} is not inside REPO_DIR ${resolve(options.repoDir)}; ` +
        "the api-standards worker keeps its state beside the checkout",
    };
  }

  const remote = options.origin ?? originForge(options.repoDir, environment);
  if (remote === undefined) {
    return { ok: false, message: "the checkout's origin does not name a supported repository" };
  }
  if (remote.forge === "gitlab") {
    return {
      ok: false,
      message: `the API Standards agent supports a GitHub or Gitea origin, not a GitLab one: ${remote.host}`,
    };
  }
  const repository = remote.project;

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
      if (!labels.some((label) => label.name === API_STANDARDS_LABEL)) {
        try {
          await giteaCreateLabel(
            target,
            API_STANDARDS_LABEL,
            LABEL_COLOR,
            LABEL_DESCRIPTION,
            options.giteaFetch,
          );
        } catch (error) {
          // Another dashboard may have created it between the read and the write.
          const after = await giteaLabels(target, options.giteaFetch);
          if (!after.some((label) => label.name === API_STANDARDS_LABEL)) {
            const detail = error instanceof GiteaError ? error.message : String(error);
            return {
              ok: false,
              message:
                `missing prerequisite: the "${API_STANDARDS_LABEL}" label could not be created in ` +
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
    `repos/${repository}/labels/${API_STANDARDS_LABEL}`,
    "--jq",
    ".name",
  ]);
  if (label.code !== 0 || label.stdout.trim() !== API_STANDARDS_LABEL) {
    const created = await execute([
      "label",
      "create",
      API_STANDARDS_LABEL,
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
          `missing prerequisite: the "${API_STANDARDS_LABEL}" label could not be created in ` +
          `${repository}: ${firstLine(created.stderr) ?? `gh exited with code ${created.code}`}`,
      };
    }
  }
  return { ok: true, repository };
}
