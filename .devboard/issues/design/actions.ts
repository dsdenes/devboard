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
  giteaLabels,
  type FetchLike,
} from "../../lib/gitea";
import { originForge } from "../repository";
import { ghCommand, runCommand } from "../scout/preflight";
import { writeAtomic } from "./state";
import { DESIGN_LABEL, workDirectory } from "./paths";
import type { DesignFinding } from "./audit";

/**
 * Filing one design-system finding as one implementation issue in the host
 * origin. The exact `design` label already exists: preflight refused Start
 * otherwise, so this path never creates it.
 */

export interface GhRunner {
  (argv: string[], environment: Record<string, string>): Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }>;
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "no diagnostic"
  );
}

function evidenceLine(entry: DesignFinding["evidence"][number]): string {
  const quote = entry.quote.replace(/\n/g, "\n  > ");
  return `- \`${entry.path}:${entry.lines}\`\n  > ${quote}`;
}

/** The issue body: category, the violated standard, evidence, and acceptance. */
export function issueBody(finding: DesignFinding): string {
  const token =
    finding.token === undefined
      ? []
      : [
          "## Violated token",
          "",
          `\`${finding.token.name}\`` +
            (finding.token.value === undefined ? "" : ` = \`${finding.token.value}\``),
          "",
        ];
  return [
    "## Category",
    "",
    finding.category,
    "",
    "## Violated principle or token",
    "",
    `**${finding.principle.name}**`,
    "",
    `> ${finding.principle.passage.replace(/\n/g, "\n> ")}`,
    "",
    ...token,
    "## Evidence",
    "",
    ...finding.evidence.map(evidenceLine),
    "",
    "## Files",
    "",
    ...finding.files.map((file) => `- \`${file}\``),
    "",
    "## Proposed change",
    "",
    finding.proposedChange,
    "",
    "## Acceptance criteria",
    "",
    ...finding.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
    "---",
    "",
    "Filed by Design System. Bring the interface in line with DESIGN.md and design/tokens.json.",
    "",
  ].join("\n");
}

export interface FileDesignIssueOptions {
  repoDir: string;
  repository: string;
  finding: DesignFinding;
  environment?: Record<string, string | undefined>;
  run?: GhRunner;
  exec?: Exec;
  now?: () => Date;
  deadline?: number;
  signal?: AbortSignal;
  forge?: Forge;
  baseUrl?: string;
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
  options: FileDesignIssueOptions,
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
  try {
    const label = (await giteaLabels(target, options.giteaFetch)).find(
      (entry) => entry.name === DESIGN_LABEL,
    );
    if (label === undefined) {
      throw new Error(`the repository has no exact "${DESIGN_LABEL}" label`);
    }
    const issue = await giteaCreateIssue(
      target,
      {
        title: options.finding.title,
        body: issueBody(options.finding),
        labels: [label.id],
      },
      options.giteaFetch,
    );
    return { url: issue.url, number: issue.number };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "no-code";
    throw new Error(`${detail} (target ${baseUrl}, project ${options.repository}, ${code})`);
  }
}

export async function fileDesignIssue(
  options: FileDesignIssueOptions,
): Promise<{ url: string; number: number }> {
  const environment = options.environment ?? process.env;
  const remote = originForge(options.repoDir, environment);
  const forge = options.forge ?? remote?.forge ?? "github";
  if (forge === "gitea") return await fileGiteaIssue(options, environment);

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

  const stamp = (options.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, "-");
  const bodyPath = join(
    workDirectory(options.repoDir),
    "issue-bodies",
    `${stamp}-${options.finding.title.slice(0, 24).replace(/[^a-z0-9]+/gi, "-")}.md`,
  );
  writeAtomic(bodyPath, issueBody(options.finding));

  const created = await run(
    [
      "issue",
      "create",
      "--repo",
      options.repository,
      "--title",
      options.finding.title,
      "--body-file",
      bodyPath,
      "--label",
      DESIGN_LABEL,
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
  if (url === undefined) throw new Error("the issue was created without a URL");
  const number = /\/issues\/(\d+)\/?$/.exec(url);
  if (number === null) throw new Error("the issue was created without an issue number");
  return { url, number: Number(number[1]) };
}
