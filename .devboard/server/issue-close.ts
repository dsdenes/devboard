import {
  authEnvironment,
  isAuthFailure,
  resolveForgeAuth,
  type Exec,
} from "../lib/forge-auth";

/**
 * The one tracker mutation the Issues overview offers: closing an open issue
 * the operator does not want implemented. It runs only from the dashboard, on
 * the checkout's own GitHub origin, with a write-capable account.
 */

export interface GhCommandOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

export type GhRunner = (
  argv: string[],
  environment: Record<string, string | undefined>,
) => Promise<GhCommandOutcome>;

export interface CloseIssueRequest {
  repoDir: string;
  /** The checkout origin's `owner/name`. */
  repository: string;
  number: number;
  environment?: Record<string, string | undefined>;
  /** Injectable forge execution; tests replace the credential probe. */
  exec?: Exec;
  /** Injectable `gh`; defaults to the operator's binary. */
  run?: GhRunner;
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

async function ghCommand(
  argv: string[],
  environment: Record<string, string | undefined>,
): Promise<GhCommandOutcome> {
  try {
    const child = Bun.spawn({
      cmd: ["gh", ...argv],
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
  const auth = await resolveForgeAuth(request.exec ?? bunExec, {
    forge: "github",
    host: "github.com",
    project: request.repository,
    cwd: request.repoDir,
    required: "write",
    env: environment,
  });
  if (isAuthFailure(auth)) throw new Error(auth.error.split("\n")[0] ?? auth.error);

  const run = request.run ?? ghCommand;
  const result = await run(
    [
      "issue",
      "close",
      String(request.number),
      "--repo",
      request.repository,
      "--reason",
      "not planned",
    ],
    authEnvironment(auth, environment),
  );
  if (result.code !== 0) {
    throw new Error(
      `Could not close issue #${request.number}: ${firstLine(result.stderr || result.stdout)}`,
    );
  }
}
