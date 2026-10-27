import { createWriteStream, mkdirSync, writeFileSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { runsDirectory } from "./state";

/**
 * One spawned agent run. Standard output and standard error are streamed
 * straight to files under `<state-dir>/orchestrator/runs/<UTC timestamp>/`, so
 * a long session never accumulates in memory; only the first stderr line is
 * kept so a failure can be described without rereading the log.
 */

export const DEFAULT_AGENT_ARGV = ["omp", "--print", "--auto-approve", "/implement-all-issues"];

export interface RunResult {
  runId: string;
  runDir: string;
  argv: string[];
  cwd: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  /** The first non-empty stderr line of the run, bounded. */
  firstStderrLine: string | null;
}

export interface RunHandle {
  runId: string;
  runDir: string;
  argv: string[];
  startedAt: string;
  exited: Promise<RunResult>;
  /** Asks the agent to stop; the exit still resolves through `exited`. */
  kill: () => void;
}

/**
 * The agent argv. `ORCHESTRATOR_AGENT_COMMAND` replaces the whole argv, split
 * on whitespace with no shell involved, so a scope can never be appended.
 */
export function agentArgv(environment: Record<string, string | undefined> = process.env): string[] {
  const override = environment.ORCHESTRATOR_AGENT_COMMAND;
  if (override === undefined || override.trim().length === 0) return [...DEFAULT_AGENT_ARGV];
  return override.trim().split(/\s+/);
}

export function runIdentifier(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function uniqueDirectory(base: string, name: string): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = join(base, attempt === 0 ? name : `${name}-${attempt}`);
    try {
      mkdirSync(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`could not create a run directory under ${base}`);
}

const FIRST_LINE_MAX = 400;

/** Collects the first non-empty stderr line without keeping the whole stream. */
class FirstLine {
  private buffer = "";
  private found = false;
  value: string | null = null;

  push(chunk: string): void {
    if (this.found) return;
    this.buffer += chunk;
    const line = this.buffer
      .split("\n")
      .map((entry) => entry.replace(/\s+$/, ""))
      .find((entry) => entry.trim().length > 0);
    if (line !== undefined) {
      this.found = true;
      const trimmed = line.trim();
      this.value =
        trimmed.length <= FIRST_LINE_MAX ? trimmed : `${trimmed.slice(0, FIRST_LINE_MAX - 1)}…`;
      this.buffer = "";
      return;
    }
    // A single unterminated line longer than the bound is kept bounded too.
    if (this.buffer.length > FIRST_LINE_MAX * 8) this.buffer = this.buffer.slice(-FIRST_LINE_MAX);
  }

  finish(): void {
    if (this.found) return;
    const trimmed = this.buffer.trim();
    if (trimmed.length === 0) return;
    this.value =
      trimmed.length <= FIRST_LINE_MAX ? trimmed : `${trimmed.slice(0, FIRST_LINE_MAX - 1)}…`;
  }
}

async function pump(
  stream: ReadableStream<Uint8Array> | null,
  sink: WriteStream,
  onText?: (text: string) => void,
): Promise<void> {
  if (stream === null) return;
  const decoder = new TextDecoder();
  try {
    for await (const chunk of stream) {
      sink.write(chunk);
      if (onText !== undefined) onText(decoder.decode(chunk, { stream: true }));
    }
  } finally {
    const closed = Promise.withResolvers<void>();
    sink.end(closed.resolve);
    await closed.promise;
  }
}

/**
 * Starts the agent and returns immediately; polling continues while it runs,
 * so an issue opened mid-run is noticed without spawning a second agent.
 */
export function startRun(options: {
  argv: string[];
  cwd: string;
  stateDir: string;
  now?: Date;
  environment?: Record<string, string | undefined>;
}): RunHandle {
  const now = options.now ?? new Date();
  const startedAt = now.toISOString();
  const runId = runIdentifier(now);
  const base = runsDirectory(options.stateDir);
  mkdirSync(base, { recursive: true });
  const runDir = uniqueDirectory(base, runId);
  writeFileSync(
    join(runDir, "command.json"),
    `${JSON.stringify({ argv: options.argv, cwd: options.cwd, startedAt }, null, 2)}\n`,
  );

  const stdout = createWriteStream(join(runDir, "stdout.log"), { flags: "a" });
  const stderr = createWriteStream(join(runDir, "stderr.log"), { flags: "a" });
  const firstLine = new FirstLine();

  const child = Bun.spawn({
    cmd: options.argv,
    cwd: options.cwd,
    env: options.environment === undefined ? process.env : { ...options.environment },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const exited = (async (): Promise<RunResult> => {
    await Promise.all([
      pump(child.stdout, stdout),
      pump(child.stderr, stderr, (text) => firstLine.push(text)),
    ]);
    const exitCode = await child.exited;
    firstLine.finish();
    const finishedAt = new Date().toISOString();
    const result: RunResult = {
      runId,
      runDir,
      argv: options.argv,
      cwd: options.cwd,
      startedAt,
      finishedAt,
      exitCode,
      firstStderrLine: firstLine.value,
    };
    writeFileSync(
      join(runDir, "result.json"),
      `${JSON.stringify(
        {
          runId,
          argv: result.argv,
          cwd: result.cwd,
          startedAt,
          finishedAt,
          exitCode,
          firstStderrLine: result.firstStderrLine,
        },
        null,
        2,
      )}\n`,
    );
    return result;
  })();

  return {
    runId,
    runDir,
    argv: options.argv,
    startedAt,
    exited,
    kill() {
      try {
        child.kill("SIGTERM");
      } catch {
        // The agent already exited.
      }
    },
  };
}
