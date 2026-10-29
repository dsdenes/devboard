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

function capture(stdout: Uint8Array, stderr: Uint8Array): { output: string; truncated: boolean } {
  const combined = `${Buffer.from(stdout).toString("utf8")}${Buffer.from(stderr).toString("utf8")}`;
  if (Buffer.byteLength(combined, "utf8") <= VERIFICATION_OUTPUT_MAX_BYTES) {
    return { output: combined, truncated: false };
  }
  const buffer = Buffer.from(combined, "utf8");
  return {
    output: `${buffer.subarray(0, VERIFICATION_OUTPUT_MAX_BYTES).toString("utf8")}\n[output truncated]`,
    truncated: true,
  };
}

/** Runs one allowlisted check; anything else is refused before a spawn. */
export async function runVerification(
  context: McpContext,
  check: unknown,
  givenPaths: unknown,
): Promise<VerificationResult> {
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
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, VERIFICATION_TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).arrayBuffer(),
    child.exited,
  ]);
  clearTimeout(timer);
  const captured = capture(new Uint8Array(stdout), new Uint8Array(stderr));
  return {
    check,
    exitCode: timedOut ? null : exitCode,
    output: timedOut ? `${captured.output}\n[timed out after ${VERIFICATION_TIMEOUT_MS} ms]` : captured.output,
    truncated: captured.truncated,
  };
}
