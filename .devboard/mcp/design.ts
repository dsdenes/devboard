import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveWithin, type McpContext } from "./context";

/**
 * The Design System release request. The audit turn edits only its cycle's
 * draft copies of the two documents; this tool records the release summary and
 * rationale beside them. The worker still owns the isolated worktree, commit,
 * push, release-workflow wait, and `bun run publish`.
 */

export const DESIGN_RELEASE_REQUEST = "release-request.json";
export const DESIGN_RELEASE_VERSION = 1;

function cycleDirectory(context: McpContext, value: unknown): string {
  const root = join(context.repoDir, ".devboard", ".tmp", "design", "cycles");
  mkdirSync(root, { recursive: true });
  return resolveWithin(root, value, "cycleDir", { mustExist: true }).absolute;
}

function sentence(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty sentence.`);
  }
  const text = value.trim();
  if (Buffer.byteLength(text, "utf8") > max) {
    throw new Error(`${field} must be at most ${max} bytes.`);
  }
  return text;
}

export function requestDesignRelease(
  context: McpContext,
  options: { cycleDir?: unknown; summary?: unknown; rationale?: unknown },
) {
  const directory = cycleDirectory(context, options.cycleDir);
  const summary = sentence(options.summary, "summary", 200);
  const rationale = sentence(options.rationale, "rationale", 4000);
  const path = join(directory, DESIGN_RELEASE_REQUEST);
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        version: DESIGN_RELEASE_VERSION,
        summary,
        rationale,
        requestedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  return { path, summary };
}
