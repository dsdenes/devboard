import { Marked, type Token, type Tokens } from "marked";

/**
 * The prepared SKILL.md body without its YAML frontmatter. The frontmatter is
 * bookkeeping: the panel header already states the name and the skills list
 * owns the description, so the document starts at the first instruction.
 */
export function skillBody(source: string): string {
  const normalized = source.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") return normalized.trim();
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (close < 0) return normalized.trim();
  return lines.slice(close + 1).join("\n").trim();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Schemes a skill link may use. Everything else, including a bare scheme guess, is refused. */
const allowedSchemes: Record<string, true> = { http: true, https: true, mailto: true };

/**
 * The destination an anchor may emit: an in-page fragment scrolls this
 * document, an external link opens its own tab, and a relative path names a
 * file the panel cannot open, so it stays text beside its label.
 */
type SkillDestination =
  | { kind: "fragment"; href: string }
  | { kind: "external"; href: string }
  | { kind: "text"; path: string };

/**
 * The destination a link may emit, or null when it must not become one.
 * A browser strips ASCII whitespace and control characters anywhere in a URL
 * before resolving its scheme, so the check runs on the stripped form and that
 * same form is what the anchor receives.
 */
function classifyHref(href: string): SkillDestination | null {
  const normalized = href.replace(/[\u0000-\u0020\u007f]/g, "");
  if (normalized.length === 0) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(normalized)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    return allowedSchemes[scheme] === true ? { kind: "external", href: normalized } : null;
  }
  if (normalized.startsWith("#")) return { kind: "fragment", href: normalized };
  return { kind: "text", path: normalized };
}

/** The visible text of a heading, with its markdown markers removed. */
function tokenText(tokens: readonly Token[]): string {
  return tokens
    .map((token) => {
      const children = (token as Token & { tokens?: Token[] }).tokens;
      return children === undefined ? token.raw : tokenText(children);
    })
    .join("");
}

/**
 * The id a heading carries and a `#fragment` names: lowercase, punctuation
 * dropped, whitespace joined with hyphens, and a numeric suffix when the same
 * heading repeats in one document.
 */
function headingSlug(text: string, taken: Map<string, number>): string {
  const base =
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .trim()
      .replace(/\s+/g, "-") || "section";
  const seen = taken.get(base) ?? 0;
  taken.set(base, seen + 1);
  return seen === 0 ? base : `${base}-${seen}`;
}

const marked = new Marked({ gfm: true });

/** The slugs one render has emitted, reset for each document. */
let headingSlugs = new Map<string, number>();

marked.use({
  renderer: {
    // A skill file is host content, not app markup: raw HTML renders as text.
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(text);
    },
    // Every heading carries the id its own document's `#fragment` links name.
    heading({ tokens, depth }: Tokens.Heading) {
      const id = escapeHtml(headingSlug(tokenText(tokens), headingSlugs));
      return `<h${depth} id="${id}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
    },
    link({ href, title, tokens }: Tokens.Link) {
      const label = this.parser.parseInline(tokens);
      const destination = classifyHref(href);
      if (destination === null) return label;
      if (destination.kind === "text") return `${label} (${escapeHtml(destination.path)})`;
      const titleAttribute = title == null ? "" : ` title="${escapeHtml(title)}"`;
      if (destination.kind === "fragment") {
        return `<a href="${escapeHtml(destination.href)}"${titleAttribute}>${label}</a>`;
      }
      return `<a href="${escapeHtml(destination.href)}"${titleAttribute} target="_blank" rel="noreferrer noopener">${label}</a>`;
    },
    image({ text }: Tokens.Image) {
      return escapeHtml(text);
    },
  },
});

/** Renders the skill body as sanitized HTML for the document panel. */
export function renderSkillDocument(source: string): string {
  const body = skillBody(source);
  if (body.length === 0) return "";
  headingSlugs = new Map();
  return marked.parse(body, { async: false });
}
