import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { McpContext } from "./context";

/**
 * The per-run record an agent's tool calls leave behind. The flow worker,
 * Coach coordinator, and watchdog coordinator set the path in the peer's
 * environment; the tool appends one line per call so the caller learns which
 * issue or record was created without asking the agent for an answer document.
 *
 * A path outside the repository and the state directory is ignored rather than
 * written: the environment is trusted configuration, but the boundary holds
 * regardless.
 */

export interface ToolLogEntry {
  tool: string;
  at: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}

function inside(root: string, candidate: string): boolean {
  const local = relative(root, candidate);
  return local.length === 0 || (!local.startsWith(`..${sep}`) && local !== ".." && !isAbsolute(local));
}

function permittedRoots(context: McpContext): string[] {
  const roots: string[] = [];
  for (const value of [context.repoDir, context.stateDir]) {
    try {
      roots.push(realpathSync(value));
    } catch {
      // A root that does not exist cannot contain the log.
    }
  }
  return roots;
}

/** The configured log path when it sits inside a permitted root. */
export function toolLogPath(
  context: McpContext,
  key = "DEVBOARD_TOOL_LOG",
): string | undefined {
  const configured = context.environment[key];
  if (typeof configured !== "string" || configured.length === 0) return undefined;
  const absolute = resolve(isAbsolute(configured) ? configured : resolve(context.repoDir, configured));
  const parent = dirname(absolute);
  let target: string;
  try {
    target = resolve(realpathSync(parent), absolute.slice(parent.length + 1));
  } catch {
    target = absolute;
  }
  const root = permittedRoots(context).find((candidate) => inside(candidate, target));
  return root === undefined ? undefined : target;
}

export function appendToolLog(
  context: McpContext,
  entry: ToolLogEntry,
  key = "DEVBOARD_TOOL_LOG",
): void {
  const path = toolLogPath(context, key);
  if (path === undefined) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
  } catch {
    // The log is diagnostic; its failure never decides a tool result.
  }
}

/** Records one tool outcome; the value or error is already redacted upstream. */
export function logToolCall(
  context: McpContext,
  tool: string,
  result: { value?: unknown; error?: string },
): void {
  appendToolLog(context, {
    tool,
    at: new Date().toISOString(),
    ok: result.error === undefined,
    ...(result.value === undefined ? {} : { value: result.value }),
    ...(result.error === undefined ? {} : { error: result.error }),
  });
}
