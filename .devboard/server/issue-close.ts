import {
  authEnvironment,
  isAuthFailure,
  resolveForgeAuth,
  type Exec,
} from "../lib/forge-auth";
import { giteaBaseUrl } from "../lib/forge";
import { giteaCloseIssue, type FetchLike } from "../lib/gitea";
import { originForge } from "../issues/repository";

/**
 * The one tracker mutation the Issues overview offers: closing an open issue
 * the operator does not want implemented. It runs only from the dashboard, on
 * the checkout's own forge origin, with a write-capable account.
 */

export interface ForgeCommandOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs one forge CLI. A GitHub close passes `gh`'s argument list; a GitLab
 * close passes the complete `glab` argv, so the dispatch is observable.
 */
export type ForgeRunner = (
  argv: string[],
  environment: Record<string, string | undefined>,
) => Promise<ForgeCommandOutcome>;

export interface CloseIssueRequest {
  repoDir: string;
  /** The checkout origin's `owner/name`. */
  repository: string;
  number: number;
  environment?: Record<string, string | undefined>;
  /** Injectable forge execution; tests replace the credential probe. */
  exec?: Exec;
  /** Injectable forge CLI; defaults to the operator's `gh`/`glab` binary. */
  run?: ForgeRunner;
  /** Overrides origin forge detection; tests use it. */
  forge?: "github" | "gitlab" | "gitea";
  /** Gitea HTTP origin; defaults to configuration and the origin remote. */
  baseUrl?: string;
  /** Injectable transport for the Gitea API. */
  giteaFetch?: FetchLike;
}

const bunExec: Exec = async (commandName, args, options) => {
  try {
    const child = Bun.spawn({
      cmd: [commandName, ...args],
      cwd: options.cwd,
      env: options.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  } catch (error) {
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      code: -1,
      killed: false,
    };
  }
};

async function spawnCommand(
  argv: string[],
  environment: Record<string, string | undefined>,
): Promise<ForgeCommandOutcome> {
  const [commandName, ...args] = argv;
  if (commandName === undefined) {
    return { code: 1, stdout: "", stderr: "No forge command was given." };
  }
  try {
    const child = Bun.spawn({
      cmd: [commandName, ...args],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...environment,
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

const ghCommand: ForgeRunner = async (argv, environment) =>
  spawnCommand(["gh", ...argv], environment);

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "no diagnostic"
  );
}

/**
 * Closes one issue as `not planned`. The closure is the operator's signal that
 * the issue must not be implemented; a running agent is not interrupted.
 */
export async function closeIssue(request: CloseIssueRequest): Promise<void> {
  if (!Number.isInteger(request.number) || request.number <= 0) {
    throw new Error("Closing an issue needs a positive issue number.");
  }
  const environment = request.environment ?? process.env;
  const remote = originForge(request.repoDir, environment);
  const forge = request.forge ?? remote?.forge ?? "github";
  if (forge !== "github" && forge !== "gitlab" && forge !== "gitea") {
    throw new Error(`Closing an issue is not supported on the ${String(forge)} forge.`);
  }
  const baseUrl =
    forge === "gitea"
      ? request.baseUrl ?? giteaBaseUrl(remote, environment)
      : undefined;
  if (forge === "gitea" && (baseUrl === undefined || baseUrl.length === 0)) {
    throw new Error("Closing a Gitea issue needs DEVBOARD_GITEA_URL.");
  }
  const auth = await resolveForgeAuth(request.exec ?? bunExec, {
    forge,
    host: remote?.host ?? "github.com",
    project: request.repository,
    cwd: request.repoDir,
    required: "write",
    env: environment,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(request.giteaFetch === undefined ? {} : { giteaFetch: request.giteaFetch }),
  });
  if (isAuthFailure(auth)) throw new Error(auth.error.split("\n")[0] ?? auth.error);

  if (forge === "gitea") {
    try {
      await giteaCloseIssue(
        {
          baseUrl: baseUrl ?? "",
          project: request.repository,
          ...(auth.token === undefined ? {} : { token: auth.token }),
        },
        request.number,
        request.giteaFetch,
      );
    } catch (error) {
      throw new Error(
        `Could not close issue #${request.number}: ` +
          firstLine(error instanceof Error ? error.message : String(error)),
      );
    }
    return;
  }

  const run = request.run ?? (forge === "github" ? ghCommand : spawnCommand);
  const argv =
    forge === "github"
      ? [
          "issue",
          "close",
          String(request.number),
          "--repo",
          request.repository,
          "--reason",
          "not planned",
        ]
      : [
          // The complete `glab` argv: `glab` has no issue-close reason and
          // must never let the close fall through to `gh`.
          "glab",
          "issue",
          "close",
          String(request.number),
          "--repo",
          request.repository,
        ];
  const result = await run(argv, authEnvironment(auth, environment));
  if (result.code !== 0) {
    throw new Error(
      `Could not close issue #${request.number}: ${firstLine(result.stderr || result.stdout)}`,
    );
  }
}
