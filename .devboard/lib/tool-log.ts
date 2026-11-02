import { readFileSync } from "node:fs";

/**
 * One line the Devboard MCP server appended for a mutating tool call. A worker
 * reads this record instead of asking an agent for a structured answer.
 */
export interface ToolRecord {
  tool?: unknown;
  at?: unknown;
  ok?: unknown;
  value?: unknown;
  error?: unknown;
}

export function readToolLog(path: string): ToolRecord[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const records: ToolRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        records.push(parsed as ToolRecord);
      }
    } catch {
      // A torn line is diagnostic; a later complete line still counts.
    }
  }
  return records;
}

export function toolValueNumber(value: unknown, field: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const entry: unknown = Reflect.get(value, field);
  return typeof entry === "number" && Number.isInteger(entry) && entry > 0 ? entry : undefined;
}

export function toolValueString(value: unknown, field: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const entry: unknown = Reflect.get(value, field);
  return typeof entry === "string" ? entry : undefined;
}
