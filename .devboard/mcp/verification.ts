import { existsSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { resolveContained } from "./context";
import type { McpContext } from "./context";

/**
 * The one verification allowlist. The tool runs a check that already exists in
 * `.devboard/package.json` with `.devboard` as its working directory; it never
 * executes an arbitrary command and never widens the list.
 */

export const VERIFICATION_TIMEOUT_MS = 900_000;
export const VERIFICATION_OUTPUT_MAX_BYTES = 16 * 1024;
export const VERIFICATION_PATH_MAX = 50;

const PLAIN_CHECKS = new Set(["test", "check", "build", "typecheck"]);

interface PackageScripts {
  [name: string]: string;
}

function scripts(context: McpContext): PackageScripts {
  const path = resolve(context.harnessDir, "package.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Cannot read ${path}; .devboard/package.json is required.`);
  }
  if (typeof parsed !== "object" || parsed === null || !("scripts" in parsed)) {
    throw new Error(".devboard/package.json carries no scripts.");
  }
  const value = parsed.scripts;
  if (typeof value !== "object" || value === null) {
    throw new Error(".devboard/package.json carries no scripts.");
  }
  const result: PackageScripts = {};
  for (const [name, body] of Object.entries(value)) {
    if (typeof body === "string") result[name] = body;
  }
  return result;
}

function insideHarness(context: McpContext, absolute: string): boolean {
  const harness = resolve(context.harnessDir);
  const local = relative(harness, absolute);
  return local.length === 0 || (!local.startsWith(`..${sep}`) && local !== "..");
}

function testPaths(context: McpContext, value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("paths must be an array of repository-relative paths.");
  if (value.length > VERIFICATION_PATH_MAX) {
    throw new Error(`At most ${VERIFICATION_PATH_MAX} test paths are accepted.`);
  }
  const paths: string[] = [];
  for (const entry of value) {
    const resolved = resolveContained(context.harnessDir, entry, "test path", { mustExist: true });
    if (!insideHarness(context, resolved.absolute)) {
      throw new Error(`A test path must stay inside .devboard: ${String(entry)}`);
    }
    const local = relative(resolve(context.harnessDir), resolved.absolute).split(sep).join("/");
    // Bun treats a bare path as a name filter; `./` makes it a file path.
    paths.push(`./${local}`);
  }
  return paths;
}

export interface VerificationResult {
  check: string;
  exitCode: number | null;
  output: string;
  truncated: boolean;
}

function capture(
  stdout: Uint8Array,
  stderr: Uint8Array,
  maxBytes: number = VERIFICATION_OUTPUT_MAX_BYTES,
): { output: string; truncated: boolean } {
  const combined = `${Buffer.from(stdout).toString("utf8")}${Buffer.from(stderr).toString("utf8")}`;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) {
    return { output: combined, truncated: false };
  }
  const buffer = Buffer.from(combined, "utf8");
  return {
    output: `${buffer.subarray(0, maxBytes).toString("utf8")}\n[output truncated]`,
    truncated: true,
  };
}

/** What one pipe has yielded so far; the timeout can snapshot it mid-read. */
interface PipeBuffer {
  chunks: Uint8Array[];
  bytes: number;
}

/**
 * Reads one pipe into `sink`, keeping at most `limit` bytes. The rest is
 * drained so a chatty check never blocks on a full pipe, but never stored:
 * the capture bound is also the memory bound. A descendant that inherits the
 * pipe can hold it open after the child dies, so the caller races this read
 * against the deadline instead of waiting for EOF.
 */
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  sink: PipeBuffer,
): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value === undefined || value.byteLength === 0) continue;
      const room = limit - sink.bytes;
      if (room <= 0) continue;
      const kept = value.byteLength <= room ? value : value.subarray(0, room);
      sink.chunks.push(kept);
      sink.bytes += kept.byteLength;
    }
  } catch {
    // A reset pipe keeps whatever was already read; the bound still holds.
  }
}

interface VerificationSettlement {
  stdout: Uint8Array;
  stderr: Uint8Array;
  exitCode: number | null;
  timedOut: boolean;
  failure?: string;
}

export interface VerificationOptions {
  /** Test seam: the wall-clock bound for the whole call. */
  timeoutMs?: number;
  /** Test seam: the per-pipe capture and output bound. */
  outputMaxBytes?: number;
}

/** Runs one allowlisted check; anything else is refused before a spawn. */
export async function runVerification(
  context: McpContext,
  check: unknown,
  givenPaths: unknown,
  options: VerificationOptions = {},
): Promise<VerificationResult> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? VERIFICATION_TIMEOUT_MS);
  const outputMaxBytes = Math.max(1, options.outputMaxBytes ?? VERIFICATION_OUTPUT_MAX_BYTES);
  if (typeof check !== "string" || check.length === 0) {
    throw new Error("A check name is required.");
  }
  const available = scripts(context);
  let argv: string[];
  if (check === "test") {
    const paths = testPaths(context, givenPaths);
    argv = [process.execPath, "test", ...paths];
  } else if (check === "typecheck") {
    argv =
      available.typecheck === undefined
        ? ["bunx", "tsc", "--noEmit"]
        : [process.execPath, "run", "typecheck"];
  } else if (check === "check" || check === "build") {
    if (available[check] === undefined) {
      throw new Error(`.devboard/package.json has no "${check}" script.`);
    }
    argv = [process.execPath, "run", check];
  } else if (check.startsWith("verify:")) {
    const name = check.slice("verify:".length);
    if (name.length === 0 || available[check] === undefined) {
      throw new Error(`.devboard/package.json has no "${check}" script.`);
    }
    argv = [process.execPath, "run", check];
  } else {
    throw new Error(
      `Unknown check: ${check}. Allowed checks: ${[...PLAIN_CHECKS].join(", ")}, verify:<name>.`,
    );
  }

  const cwd = resolve(context.harnessDir);
  if (!existsSync(cwd)) throw new Error(`${cwd} does not exist.`);

  const controller = new AbortController();
  let killChild: (() => void) | undefined;
  const stdout: PipeBuffer = { chunks: [], bytes: 0 };
  const stderr: PipeBuffer = { chunks: [], bytes: 0 };

  const invocation = (async (): Promise<VerificationSettlement> => {
    const child = Bun.spawn({
      cmd: argv,
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...context.environment,
        CI: context.environment.CI ?? "1",
        NO_COLOR: "1",
      },
      signal: controller.signal,
      // The check leads its own process group so the deadline reaps every
      // descendant that inherited the pipes, not just the direct child.
      detached: true,
    });
    killChild = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group is already gone, or the platform has no process groups.
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // The child is already gone; the timeout result still stands.
      }
    };
    const [exitCode] = await Promise.all([
      child.exited,
      readCapped(child.stdout, outputMaxBytes, stdout),
      readCapped(child.stderr, outputMaxBytes, stderr),
    ]);
    return {
      stdout: new Uint8Array(Buffer.concat(stdout.chunks)),
      stderr: new Uint8Array(Buffer.concat(stderr.chunks)),
      exitCode,
      timedOut: false,
    };
  })().catch(
    (error: unknown): VerificationSettlement => ({
      stdout: new Uint8Array(Buffer.concat(stdout.chunks)),
      stderr: new Uint8Array(Buffer.concat(stderr.chunks)),
      exitCode: -1,
      timedOut: false,
      failure: error instanceof Error ? error.message : String(error),
    }),
  );

  const timeout = Promise.withResolvers<VerificationSettlement>();
  const timer = setTimeout(() => {
    // The abort ends the child; the group SIGKILL covers its descendants and
    // any direct child that ignores the abort.
    controller.abort();
    killChild?.();
    timeout.resolve({
      stdout: new Uint8Array(Buffer.concat(stdout.chunks)),
      stderr: new Uint8Array(Buffer.concat(stderr.chunks)),
      exitCode: null,
      timedOut: true,
    });
  }, timeoutMs);

  try {
    const settled = await Promise.race([invocation, timeout.promise]);
    if (settled.failure !== undefined) throw new Error(settled.failure);
    const captured = capture(settled.stdout, settled.stderr, outputMaxBytes);
    return {
      check,
      exitCode: settled.timedOut ? null : settled.exitCode,
      output: settled.timedOut
        ? `${captured.output}\n[timed out after ${timeoutMs} ms]`
        : captured.output,
      truncated: captured.truncated,
    };
  } finally {
    clearTimeout(timer);
  }
}
