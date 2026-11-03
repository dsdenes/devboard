/**
 * The shared child-process runner behind every shipped agent, and the one
 * `gh` wrapper built on it. A command runs under an optional deadline and an
 * optional abort signal, both bounded by a SIGTERM-then-SIGKILL termination,
 * so a stalled child always settles and always reports a non-zero exit.
 */

export interface CommandOutcome {
  code: number;
  stdout: string;
  stderr: string;
  /** The child was asked to stop at the deadline or on abort. */
  killed?: boolean;
}

export interface CommandOptions {
  /** Kill the child when this many milliseconds elapse. */
  timeoutMs?: number;
  /** Kill the child when this signal aborts. */
  signal?: AbortSignal;
  /** Working directory; inherits the worker's when omitted. */
  cwd?: string;
}

/** How long a child may ignore SIGTERM before it is sent SIGKILL. */
const TERMINATE_GRACE_MS = 200;

/**
 * Runs one child under an optional deadline. A child that ignores SIGTERM is
 * killed with SIGKILL after a short grace, so a stalled command always
 * settles and always reports a non-zero exit.
 */
export async function runCommand(
  command: string[],
  environment?: Record<string, string | undefined>,
  options: CommandOptions = {},
): Promise<CommandOutcome> {
  if (options.signal?.aborted === true) {
    return { code: 1, stdout: "", stderr: "the command was cancelled", killed: true };
  }
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn({
      cmd: command,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: environment ?? process.env,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
  } catch (error) {
    return { code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }

  let killed = false;
  let grace: Timer | undefined;
  const terminate = (): void => {
    if (killed) return;
    killed = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // The child already exited.
    }
    grace = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // It exited inside the grace period.
      }
    }, TERMINATE_GRACE_MS);
    grace.unref?.();
  };

  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(terminate, Math.max(1, options.timeoutMs));
  timer?.unref?.();
  const onAbort = (): void => terminate();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const diagnostic = killed
      ? `${stderr.length === 0 ? "" : `${stderr}\n`}the command did not finish before its deadline`
      : stderr;
    // A child killed at the deadline never counts as a successful command,
    // even when it happened to exit 0 while the signal was being delivered.
    return { code: killed && code === 0 ? 1 : code, stdout, stderr: diagnostic, killed };
  } finally {
    clearTimeout(timer);
    clearTimeout(grace);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** Runs the operator's `gh` through the runner, with its prompts disabled. */
export async function ghCommand(
  argv: string[],
  environment?: Record<string, string | undefined>,
  options: CommandOptions = {},
): Promise<CommandOutcome> {
  return await runCommand(
    ["gh", ...argv],
    {
      ...(environment ?? process.env),
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      GIT_TERMINAL_PROMPT: "0",
      NO_COLOR: "1",
    },
    options,
  );
}
