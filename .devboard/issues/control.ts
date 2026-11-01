import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isInteger, isRecord } from "./guards";

/**
 * The dashboard-to-worker channel. Commands are individual files created by
 * atomic rename, so the worker never reads a half-written command, and their
 * names sort in submission order. A worker consumes them from any dashboard
 * attached to the same repository state.
 */

export type IssuesCommand =
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop" }
  | { type: "drain" }
  | { type: "check" }
  | { type: "answer"; id: number | string; value: string; runId?: string }
  /** End one issue's run because the tracker now reports that issue closed. */
  | { type: "abandon"; number: number };

let sequence = 0;

export function writeCommand(directory: string, command: IssuesCommand): string {
  mkdirSync(directory, { recursive: true });
  sequence += 1;
  const name = `${String(Date.now()).padStart(14, "0")}-${String(sequence).padStart(6, "0")}.json`;
  const path = join(directory, name);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(command)}\n`);
  renameSync(temporary, path);
  return path;
}

function parseCommand(text: string): IssuesCommand | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  switch (parsed.type) {
    case "pause":
    case "resume":
    case "stop":
    case "drain":
    case "check":
      return { type: parsed.type };
    case "answer":
      if (
        (typeof parsed.id === "string" || isInteger(parsed.id)) &&
        typeof parsed.value === "string" &&
        (parsed.runId === undefined || typeof parsed.runId === "string")
      ) {
        return {
          type: "answer",
          id: parsed.id,
          value: parsed.value,
          ...(parsed.runId === undefined ? {} : { runId: parsed.runId }),
        };
      }
      return undefined;
    case "abandon":
      return isInteger(parsed.number) && parsed.number > 0
        ? { type: "abandon", number: parsed.number }
        : undefined;
    default:
      return undefined;
  }
}

/** Reads and consumes every pending command in name order. */
export function takeCommands(directory: string): IssuesCommand[] {
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const commands: IssuesCommand[] = [];
  for (const name of names) {
    const path = join(directory, name);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    try {
      unlinkSync(path);
    } catch {
      // Another consumer already took it.
    }
    const command = parseCommand(text);
    if (command !== undefined) commands.push(command);
  }
  return commands;
}
