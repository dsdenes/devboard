import {
  authEnvironment,
  DEFAULT_COMMAND_TIMEOUT_MS,
  ForgeTimeoutError,
  isAuthFailure,
  resolveForgeAuth,
  spawnExec,
  stringEnvironment,
  withForgeDeadline,
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
  /**
   * Bound on the credential probe and on one forge command; defaults to
   * `DEFAULT_COMMAND_TIMEOUT_MS`. A close past its deadline fails with a
   * retryable message instead of leaving the operator's control pending.
   */
  timeoutMs?: number;
}

/** The forge CLI environment: no prompt, no update check, no color. */
const FORGE_CLI_ENV = {
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GIT_TERMINAL_PROMPT: "0",
  NO_COLOR: "1",
} as const;

/**
 * Runs one forge CLI through the shared bounded `spawnExec`. A `gh`/`glab`
 * that never exits is killed at the deadline, so the close action reports a
 * retryable failure instead of staying pending.
 */
async function spawnCommand(
  argv: string[],
  environment: Record<string, string | undefined>,
  timeoutMs: number,
  operation: string,
): Promise<ForgeCommandOutcome> {
  const [commandName, ...args] = argv;
  if (commandName === undefined) {
    return { code: 1, stdout: "", stderr: "No forge command was given." };
  }
  const result = await spawnExec(commandName, args, {
    env: { ...stringEnvironment(environment), ...FORGE_CLI_ENV },
    timeout: timeoutMs,
  });
  // `code: -1` with `killed` is the deadline, not the child's own exit:
  // report it as the same retryable timeout the caller-level bound throws.
  if (result.killed === true && result.code === -1) {
    throw new ForgeTimeoutError(`${operation} timed out after ${timeoutMs} ms; retry the request.`);
  }
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}

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
  const timeoutMs = Math.max(1, request.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
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
  const auth = await withForgeDeadline(
    resolveForgeAuth(request.exec ?? spawnExec, {
      forge,
      host: remote?.host ?? "github.com",
      project: request.repository,
      cwd: request.repoDir,
      required: "write",
      env: environment,
      deadline: Date.now() + timeoutMs,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(request.giteaFetch === undefined ? {} : { giteaFetch: request.giteaFetch }),
    }),
    timeoutMs,
    "resolving the forge credential",
  );
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

  const run =
    request.run ??
    ((argv: string[], environment: Record<string, string | undefined>) =>
      spawnCommand(
        forge === "github" ? ["gh", ...argv] : argv,
        environment,
        timeoutMs,
        `closing issue #${request.number}`,
      ));
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
  const result = await withForgeDeadline(
    run(argv, authEnvironment(auth, environment)),
    timeoutMs,
    `closing issue #${request.number}`,
  );
  if (result.code !== 0) {
    throw new Error(
      `Could not close issue #${request.number}: ${firstLine(result.stderr || result.stdout)}`,
    );
  }
}
