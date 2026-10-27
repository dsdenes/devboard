/** One shared object guard for every issues boundary parser. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}
