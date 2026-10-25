export interface DiffLine {
  kind: "same" | "added" | "removed";
  text: string;
}

export const DISCOVER_DIFF_OPTIONS = {
  outputFormat: "line-by-line" as const,
  drawFileList: false,
  matching: "none" as const,
};

/** Line diff without a dependency; the baseline is the left side. */
export function diffLines(baseline: string, current: string): DiffLine[] {
  const before = baseline.split("\n");
  const after = current.split("\n");
  const rows: DiffLine[] = [];
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    rows.push({ kind: "same", text: before[start] ?? "" });
    start += 1;
  }

  let beforeEnd = before.length - 1;
  let afterEnd = after.length - 1;
  const tail: DiffLine[] = [];
  while (beforeEnd >= start && afterEnd >= start && before[beforeEnd] === after[afterEnd]) {
    tail.unshift({ kind: "same", text: before[beforeEnd] ?? "" });
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  const a = before.slice(start, beforeEnd + 1);
  const b = after.slice(start, afterEnd + 1);
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] =
        a[i] === b[j]
          ? (table[i + 1]![j + 1] ?? 0) + 1
          : Math.max(table[i + 1]![j] ?? 0, table[i]![j + 1] ?? 0);
    }
  }

  const middle: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      middle.push({ kind: "same", text: a[i] ?? "" });
      i += 1;
      j += 1;
    } else if ((table[i + 1]![j] ?? 0) >= (table[i]![j + 1] ?? 0)) {
      middle.push({ kind: "removed", text: a[i] ?? "" });
      i += 1;
    } else {
      middle.push({ kind: "added", text: b[j] ?? "" });
      j += 1;
    }
  }
  while (i < a.length) {
    middle.push({ kind: "removed", text: a[i] ?? "" });
    i += 1;
  }
  while (j < b.length) {
    middle.push({ kind: "added", text: b[j] ?? "" });
    j += 1;
  }

  return [...rows, ...middle, ...tail];
}

export function unifiedDiff(name: string, baseline: string, current: string): string {
  const positioned: Array<DiffLine & { oldLine: number; newLine: number }> = [];
  let oldLine = 1;
  let newLine = 1;
  for (const line of diffLines(baseline, current)) {
    positioned.push({ ...line, oldLine, newLine });
    if (line.kind !== "added") oldLine += 1;
    if (line.kind !== "removed") newLine += 1;
  }

  const changed = positioned
    .map((line, index) => (line.kind === "same" ? -1 : index))
    .filter((index) => index >= 0);
  if (changed.length === 0) return "";

  const context = 3;
  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(positioned.length - 1, index + context);
    const last = ranges[ranges.length - 1];
    if (last !== undefined && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  const output = [`--- a/${name}/SKILL.md`, `+++ b/${name}/SKILL.md`];
  for (const range of ranges) {
    const slice = positioned.slice(range.start, range.end + 1);
    const first = slice[0] as DiffLine & { oldLine: number; newLine: number };
    const oldCount = slice.filter((line) => line.kind !== "added").length;
    const newCount = slice.filter((line) => line.kind !== "removed").length;
    const oldStart = oldCount === 0 ? Math.max(1, first.oldLine - 1) : first.oldLine;
    const newStart = newCount === 0 ? Math.max(1, first.newLine - 1) : first.newLine;
    output.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const line of slice) {
      output.push(
        line.kind === "added"
          ? `+${line.text}`
          : line.kind === "removed"
            ? `-${line.text}`
            : ` ${line.text}`,
      );
    }
  }
  output.push("");
  return output.join("\n");
}
