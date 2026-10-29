import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../guards";
import { isValidCadence, isValidLimit } from "./state";

/**
 * The dashboard-to-design-worker channel. Commands are individual files
 * created by atomic rename, so the worker never reads a half-written command.
 */

export type DesignCommand =
  | { type: "stop" }
  | { type: "limits"; maxPerHour: number | null; maxPending: number | null }
  | { type: "cadence"; intervalMinutes: number };

let sequence = 0;

export function writeCommand(directory: string, command: DesignCommand): string {
  mkdirSync(directory, { recursive: true });
  sequence += 1;
  const name = `${String(Date.now()).padStart(14, "0")}-${String(sequence).padStart(6, "0")}.json`;
  const path = join(directory, name);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(command)}\n`);
  renameSync(temporary, path);
  return path;
}

export function parseCommand(text: string): DesignCommand | undefined {
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
    case "cadence":
      if (!isValidCadence(parsed.intervalMinutes)) return undefined;
      return { type: "cadence", intervalMinutes: parsed.intervalMinutes };
    default:
      return undefined;
  }
}

export function takeCommands(directory: string): DesignCommand[] {
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const commands: DesignCommand[] = [];
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
