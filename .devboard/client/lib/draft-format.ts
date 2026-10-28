/** The structure shared by the draft writers in `server/feedback.ts` and
 * `server/goal-proposal.ts`. */
export interface DraftContextFact {
  label: string;
  value: string;
}

export interface DraftContextSection {
  title: string;
  body: string;
}

export interface DraftParts {
  /** The draft before `## Captured UI context`, without the heading the panel already shows. */
  proposal: string;
  /** Everything after the marker, trimmed; empty when the marker is absent. */
  rawContext: string;
  facts: DraftContextFact[];
  sections: DraftContextSection[];
}

const CONTEXT_MARKER = "## Captured UI context";

/**
 * Splits a draft into its proposal and captured context. Both writers put the
 * evidence after this one marker; the proposal keeps the writer's own note.
 */
export function splitDraftText(text: string): { proposal: string; rawContext: string } {
  const index = text.indexOf(CONTEXT_MARKER);
  const before = index === -1 ? text : text.slice(0, index);
  return {
    proposal: before.trim().replace(/^#\s+[^\n]*/, "").trim(),
    rawContext: index === -1 ? "" : text.slice(index + CONTEXT_MARKER.length).trim(),
  };
}

function stripFence(text: string): string {
  return text
    .trim()
    .replace(/^```[\w-]*\n/, "")
    .replace(/\n```$/, "");
}

/**
 * Reads the facts and the two evidence blocks the writers emit. An embedded
 * capture inside the visible text repeats `### Visible text` / `### DOM
 * excerpt`; the outer blocks are the first visible heading and the last DOM
 * heading, so the embedded headings stay inside the visible text.
 */
export function parseDraftContext(raw: string): {
  facts: DraftContextFact[];
  sections: DraftContextSection[];
} {
  const lines = raw.split("\n");
  const facts: DraftContextFact[] = [];
  let index = 0;
  for (; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fact = /^-\s+([^:]+):\s*(.*)$/.exec(line);
    if (fact !== null) {
      facts.push({ label: fact[1]!, value: fact[2]!.replace(/`/g, "") });
      continue;
    }
    if (line.trim().length > 0) break;
  }
  const body = lines.slice(index);
  const first = (title: string): number =>
    body.findIndex((line) => line.trim() === `### ${title}`);
  const last = (title: string): number => {
    for (let at = body.length - 1; at >= 0; at -= 1) {
      if (body[at]!.trim() === `### ${title}`) return at;
    }
    return -1;
  };
  const visible = first("Visible text");
  const dom = last("DOM excerpt");
  const sections: DraftContextSection[] = [];
  const add = (title: string, from: number, to: number): void => {
    sections.push({ title, body: stripFence(body.slice(from, to).join("\n")) });
  };
  if (visible !== -1 && (dom === -1 || visible < dom)) {
    add("Visible text", visible + 1, dom === -1 ? body.length : dom);
    if (dom !== -1) add("DOM excerpt", dom + 1, body.length);
  } else if (dom !== -1) {
    add("DOM excerpt", dom + 1, body.length);
  }
  return { facts, sections };
}

/** Everything the detail panel reads from one draft's bytes. */
export function draftParts(text: string): DraftParts {
  const { proposal, rawContext } = splitDraftText(text);
  return { proposal, rawContext, ...parseDraftContext(rawContext) };
}
