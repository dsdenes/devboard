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
import { findOnPath, originForge, rootProblem } from "../repository";
import type { ForgeRemote } from "../../lib/forge";
import { DESIGN_LABEL, LABEL_COLOR, LABEL_DESCRIPTION, type DesignConfig } from "./paths";

/**
 * Everything Start proves before it spawns the design worker: the canonical
 * source checkout carries the interface and both documents, the origin is a
 * supported forge with a write-capable account, the `design` label is present
 * (created when the repository lacks it), and every tool the autonomous release
 * path needs is present. A refusal names the missing fact, spawns no worker,
 * and writes no state.
 */

export type DesignPreflightResult = { ok: true; repository: string } | { ok: false; message: string };

export interface DesignPreflightOptions {
  repoDir: string;
  stateDir: string;
  config: DesignConfig;
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

export async function preflightDesign(options: DesignPreflightOptions): Promise<DesignPreflightResult> {
  const environment = options.environment ?? process.env;
  const root = rootProblem(options.repoDir);
  if (root !== undefined) return { ok: false, message: root };

  if (!existsSync(join(resolve(options.repoDir), options.config.sourceDir))) {
    return {
      ok: false,
      message:
        `missing prerequisite: the canonical harness source checkout has no ` +
        `${options.config.sourceDir} directory (an installed npm prefix is refused)`,
    };
  }
  const indexCandidates = [
    join(resolve(options.repoDir), options.config.sourceDir, "index.html"),
    join(resolve(options.repoDir), options.config.sourceDir, "..", "index.html"),
  ];
  if (!indexCandidates.some((candidate) => existsSync(candidate))) {
    return {
      ok: false,
      message: `missing prerequisite: ${options.config.sourceDir} has no index.html entry`,
    };
  }
  for (const document of [options.config.designDocument, options.config.tokenDocument]) {
    if (!existsSync(join(resolve(options.repoDir), document))) {
      return { ok: false, message: `missing prerequisite: ${document} is missing` };
    }
  }

  if (!inside(options.repoDir, options.stateDir)) {
    return {
      ok: false,
      message:
        `STATE_DIR ${resolve(options.stateDir)} is not inside REPO_DIR ${resolve(options.repoDir)}; ` +
        "the design worker keeps its state beside the checkout",
    };
  }

  const remote = options.origin ?? originForge(options.repoDir, environment);
  if (remote === undefined) {
    return { ok: false, message: "the checkout's origin does not name a supported repository" };
  }
  if (remote.forge === "gitlab") {
    return {
      ok: false,
      message: `the design agent supports a GitHub or Gitea origin, not a GitLab one: ${remote.host}`,
    };
  }
  const repository = remote.project;

  for (const tool of ["git", "bun", "npm"]) {
    if (findOnPath(tool, environment) === undefined) {
      return { ok: false, message: `missing prerequisite: ${tool} is not on PATH` };
    }
  }
  if (remote.forge === "github" && findOnPath("gh", environment) === undefined) {
    return { ok: false, message: "missing prerequisite: gh is not on PATH" };
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
      if (!labels.some((label) => label.name === DESIGN_LABEL)) {
        try {
          await giteaCreateLabel(
            target,
            DESIGN_LABEL,
            LABEL_COLOR,
            LABEL_DESCRIPTION,
            options.giteaFetch,
          );
        } catch (error) {
          // Another dashboard may have created it between the read and the write.
          const after = await giteaLabels(target, options.giteaFetch);
          if (!after.some((label) => label.name === DESIGN_LABEL)) {
            const detail = error instanceof GiteaError ? error.message : String(error);
            return {
              ok: false,
              message:
                `missing prerequisite: the "${DESIGN_LABEL}" label could not be created in ` +
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
  const label = await execute(["api", `repos/${repository}/labels/${DESIGN_LABEL}`, "--jq", ".name"]);
  if (label.code !== 0 || label.stdout.trim() !== DESIGN_LABEL) {
    const created = await execute([
      "label",
      "create",
      DESIGN_LABEL,
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
          `missing prerequisite: the "${DESIGN_LABEL}" label could not be created in ` +
          `${repository}: ${firstLine(created.stderr) ?? `gh exited with code ${created.code}`}`,
      };
    }
  }
  return { ok: true, repository };
}
