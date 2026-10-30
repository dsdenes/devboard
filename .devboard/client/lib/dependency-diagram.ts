import { scalarText } from "./discover-format";

/** One directed architecture edge: `from` depends on `to`. */
export interface DependencyEdge {
  from: string;
  to: string;
}

/**
 * Reads the recorded `architecture.dependencies` value into the directed edges
 * a diagram can draw. The server rejects anything this function would drop, so
 * the filtering only keeps a stale or hand-edited sheet from breaking the
 * page: blank fields, self-edges, malformed records, and repeated edges are
 * ignored.
 */
export function dependencyEdges(value: unknown): DependencyEdge[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const edges: DependencyEdge[] = [];
  for (const record of value) {
    if (typeof record !== "object" || record === null || Array.isArray(record)) continue;
    const fields = record as Record<string, unknown>;
    const from = scalarText(fields.from).trim();
    const to = scalarText(fields.to).trim();
    if (from.length === 0 || to.length === 0 || from === to) continue;
    const key = `${from}\u0000${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, to });
  }
  edges.sort((left, right) => {
    const byFrom = left.from.localeCompare(right.from);
    return byFrom !== 0 ? byFrom : left.to.localeCompare(right.to);
  });
  return edges;
}

/** Fit keeps the graph whole; actual size keeps every label at its drawn size. */
export type DiagramMode = "fit" | "actual";

/**
 * A fitted diagram may not shrink its 12px labels below a readable size. This
 * is the smallest fit scale that still clears 10.8px of text.
 */
export const DIAGRAM_MIN_READABLE_SCALE = 0.9;

/**
 * Picks the diagram presentation for a measured graph. A chosen mode always
 * wins; otherwise the graph fits only while its labels stay readable, and a
 * wide graph opens at actual size inside the scrolling canvas.
 */
export function diagramMode(
  naturalWidth: number,
  availableWidth: number,
  chosen: DiagramMode | null,
): DiagramMode {
  if (chosen !== null) return chosen;
  if (naturalWidth <= 0 || availableWidth <= 0) return "fit";
  return availableWidth / naturalWidth >= DIAGRAM_MIN_READABLE_SCALE ? "fit" : "actual";
}

function mermaidLabel(text: string): string {
  return text.replace(/"/g, "#quot;").replace(/[\r\n]+/g, " ").trim();
}

/**
 * Builds a Mermaid flowchart for the bounded contexts and the recorded
 * dependencies. Returns null when there is nothing to draw. Node ids are
 * generated, so a context name can never inject Mermaid syntax.
 */
export function dependencyChart(
  contextNames: string[],
  edges: DependencyEdge[],
): string | null {
  if (edges.length === 0) return null;
  const labels = new Map<string, string>();
  for (const name of contextNames) {
    const label = name.trim();
    if (label.length > 0 && !labels.has(label)) labels.set(label, `n${labels.size}`);
  }
  for (const edge of edges) {
    for (const name of [edge.from, edge.to]) {
      if (!labels.has(name)) labels.set(name, `n${labels.size}`);
    }
  }
  if (labels.size === 0) return null;

  const lines = ["flowchart LR"];
  for (const [label, id] of labels) {
    lines.push(`  ${id}("${mermaidLabel(label)}")`);
  }
  for (const edge of edges) {
    const from = labels.get(edge.from);
    const to = labels.get(edge.to);
    if (from === undefined || to === undefined) continue;
    lines.push(`  ${from} --> ${to}`);
  }
  return lines.join("\n");
}
