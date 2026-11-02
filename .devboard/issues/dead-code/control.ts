import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../guards";
import { isValidCadence, isValidLimit } from "./state";

/**
 * The dashboard-to-Dead-Code-worker channel. Commands are individual files
 * created by atomic rename, so the worker never reads a half-written command.
 */

export type DeadCodeCommand =
  | { type: "stop" }
  | { type: "drain" }
  | { type: "refresh" }
  | {
      type: "settings";
      intervalMinutes: number;
      maxPerHour: number | null;
      maxPending: number | null;
    };

let sequence = 0;

export function writeCommand(directory: string, command: DeadCodeCommand): string {
  mkdirSync(directory, { recursive: true });
  sequence += 1;
  const name = `${String(Date.now()).padStart(14, "0")}-${String(sequence).padStart(6, "0")}.json`;
  const path = join(directory, name);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(command)}\n`);
  renameSync(temporary, path);
  return path;
}

export function parseCommand(text: string): DeadCodeCommand | undefined {
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
    case "drain":
      return { type: "drain" };
    case "refresh":
      return { type: "refresh" };
    case "settings":
      if (
        !isValidCadence(parsed.intervalMinutes) ||
        !isValidLimit(parsed.maxPerHour) ||
        !isValidLimit(parsed.maxPending)
      ) {
        return undefined;
      }
      return {
        type: "settings",
        intervalMinutes: parsed.intervalMinutes,
        maxPerHour: parsed.maxPerHour,
        maxPending: parsed.maxPending,
      };
    default:
      return undefined;
  }
}

export function takeCommands(directory: string): DeadCodeCommand[] {
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const commands: DeadCodeCommand[] = [];
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
