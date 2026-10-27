import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../guards";
import { isValidLimit } from "./state";

/**
 * The dashboard-to-scout channel. Commands are individual files created by
 * atomic rename, so the worker never reads a half-written command, and their
 * names sort in submission order. A worker consumes them from any dashboard
 * attached to the same repository state. Only Stop and a limits change remain:
 * filing needs no command.
 */

export type ScoutCommand =
  | { type: "stop" }
  | { type: "limits"; maxPerHour: number; maxPending: number };

let sequence = 0;

export function writeCommand(directory: string, command: ScoutCommand): string {
  mkdirSync(directory, { recursive: true });
  sequence += 1;
  const name = `${String(Date.now()).padStart(14, "0")}-${String(sequence).padStart(6, "0")}.json`;
  const path = join(directory, name);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(command)}\n`);
  renameSync(temporary, path);
  return path;
}

export function parseCommand(text: string): ScoutCommand | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  switch (parsed.type) {
    case "stop":
      return { type: "stop" };
    case "limits":
      if (!isValidLimit(parsed.maxPerHour) || !isValidLimit(parsed.maxPending)) return undefined;
      return {
        type: "limits",
        maxPerHour: parsed.maxPerHour,
        maxPending: parsed.maxPending,
      };
    default:
      return undefined;
  }
}

/** Reads and consumes every pending command in name order. */
export function takeCommands(directory: string): ScoutCommand[] {
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const commands: ScoutCommand[] = [];
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
