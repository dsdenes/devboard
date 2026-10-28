import { join } from "node:path";
import {
  authEnvironment,
  isAuthFailure,
  resolveForgeAuth,
  type Exec,
} from "../../lib/forge-auth";
import { configuredGiteaToken, giteaBaseUrl, type Forge } from "../../lib/forge";
import {
  giteaCreateIssue,
  giteaEnsureLabel,
  type FetchLike,
} from "../../lib/gitea";
import { originForge } from "../repository";
import { ghCommand, runCommand } from "./preflight";
import { issueBodyDirectory } from "./paths";
import { writeAtomic } from "./state";
import type { ScoutRecommendation } from "./recommendation";

/**
 * Filing one recommendation as one issue in the host origin. It is called only
 * from the detached worker, and a failure throws so the scan records the reason
 * and files nothing else.
 */

export interface GhRunner {
  (argv: string[], environment: Record<string, string>): Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }>;
}

export const SCOUT_LABEL = "scout";

const LABEL_DESCRIPTION = "Significant improvement recommendation from Auto Scout";

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "no diagnostic"
  );
}

function evidenceLine(entry: ScoutRecommendation["evidence"][number]): string {
  const quote =
    entry.quote === undefined ? "" : `\n  > ${entry.quote.replace(/\n/g, "\n  > ")}`;
  return `- \`${entry.path}:${entry.lines}\`${quote}`;
}

/** The issue body: everything the implementer needs, and nothing else. */
export function issueBody(recommendation: ScoutRecommendation): string {
  return [
    `## Category`,
    "",
    recommendation.category,
    "",
    "## Summary",
    "",
    recommendation.summary,
    "",
    ...(recommendation.impact.length === 0
      ? []
      : ["## Impact", "", recommendation.impact, ""]),
    "## Significance",
    "",
    `${recommendation.significance}/5`,
    "",
    recommendation.significanceReason,
    "",
    "## Evidence",
    "",
    ...recommendation.evidence.map(evidenceLine),
    "",
    "## Proposed change",
    "",
    recommendation.proposedChange,
    "",
    "## Files",
    "",
    ...recommendation.files.map((file) => `- \`${file}\``),
    "",
    "## Acceptance criteria",
    "",
    ...recommendation.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
    "---",
    "",
    "Filed by Auto Scout. Implement this issue the way any other open issue is implemented.",
    "",
  ].join("\n");
}

export interface FileIssueOptions {
  repoDir: string;
  /** The host origin's `owner/name`. */
  repository: string;
  recommendation: ScoutRecommendation;
  environment?: Record<string, string | undefined>;
  /** Injectable forge commands; defaults to the operator's `gh`. */
  run?: GhRunner;
  exec?: Exec;
  now?: () => Date;
  /**
   * Absolute epoch deadline for the whole filing. Every probe and command is
   * killed when it elapses; commands before it are bounded by what remains.
   */
  deadline?: number;
  /** Aborting cancels an in-flight probe or command. */
  signal?: AbortSignal;
  /** Overrides origin forge detection; tests use it. */
  forge?: Forge;
  /** Gitea HTTP origin. */
  baseUrl?: string;
  /** Injectable transport for the Gitea API. */
  giteaFetch?: FetchLike;
}

const bunExec: Exec = async (commandName, args, options) => {
  const result = await runCommand([commandName, ...args], options.env, {
    cwd: options.cwd,
    ...(options.timeout === undefined ? {} : { timeoutMs: options.timeout }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
    killed: result.killed ?? false,
  };
};

async function fileGiteaIssue(
  options: FileIssueOptions,
  environment: Record<string, string | undefined>,
): Promise<{ url: string; number: number }> {
  const remote = originForge(options.repoDir, environment);
  const baseUrl = options.baseUrl ?? giteaBaseUrl(remote, environment);
  if (baseUrl === undefined || baseUrl.length === 0) {
    throw new Error("filing a Gitea issue needs DEVBOARD_GITEA_URL");
  }
  const token = configuredGiteaToken(environment);
  if (token === undefined) throw new Error("filing a Gitea issue needs GITEA_TOKEN");
  const target = { baseUrl, project: options.repository, token };
  const label = await giteaEnsureLabel(
    target,
    SCOUT_LABEL,
    "0e8a16",
    LABEL_DESCRIPTION,
    options.giteaFetch,
  );
  const issue = await giteaCreateIssue(
    target,
    {
      title: options.recommendation.title,
      body: issueBody(options.recommendation),
      labels: [label],
    },
    options.giteaFetch,
  );
  return { url: issue.url, number: issue.number };
}

/**
 * Files one issue for one staged recommendation. The label is created when it
 * is absent, the body is passed as a file, and the returned URL is the only
 * fact recorded in the decisions.
 */
export async function fileScoutIssue(options: FileIssueOptions): Promise<{ url: string; number: number }> {
  const environment = options.environment ?? process.env;
  const remote = originForge(options.repoDir, environment);
  const forge = options.forge ?? remote?.forge ?? "github";
  if (forge === "gitea") {
    return await fileGiteaIssue(options, environment);
  }
  const auth = await resolveForgeAuth(options.exec ?? bunExec, {
    forge,
    host: remote?.host ?? "github.com",
    project: options.repository,
    cwd: options.repoDir,
    required: "write",
    env: environment,
    ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (isAuthFailure(auth)) throw new Error(auth.error.split("\n")[0] ?? auth.error);
  const forgeEnvironment = authEnvironment(auth, environment);
  const run =
    options.run ??
    ((argv, env) =>
      ghCommand(argv, env, {
        ...(options.deadline === undefined
          ? {}
          : { timeoutMs: Math.max(1, options.deadline - Date.now()) }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }));

  const existing = await run(["api", `repos/${options.repository}/labels/${SCOUT_LABEL}`], forgeEnvironment);
  if (existing.code !== 0) {
    const created = await run(
      [
        "label",
        "create",
        SCOUT_LABEL,
        "--repo",
        options.repository,
        "--description",
        LABEL_DESCRIPTION,
        "--color",
        "0e8a16",
      ],
      forgeEnvironment,
    );
    if (created.code !== 0) {
      throw new Error(`could not create the scout label: ${firstLine(created.stderr)}`);
    }
  }

  const stamp = (options.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, "-");
  const bodyPath = join(issueBodyDirectory(options.repoDir), `${options.recommendation.id}-${stamp}.md`);
  writeAtomic(bodyPath, issueBody(options.recommendation));

  const created = await run(
    [
      "issue",
      "create",
      "--repo",
      options.repository,
      "--title",
      options.recommendation.title,
      "--body-file",
      bodyPath,
      "--label",
      SCOUT_LABEL,
    ],
    forgeEnvironment,
  );
  if (created.code !== 0) {
    throw new Error(`could not file the issue: ${firstLine(created.stderr)}`);
  }
  const url = created.stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^https?:\/\//.test(line));
  if (url === undefined) {
    throw new Error("the issue was created without a URL");
  }
  const number = /\/issues\/(\d+)\/?$/.exec(url);
  if (number === null) {
    throw new Error("the issue was created without an issue number");
  }
  return { url, number: Number(number[1]) };
}
