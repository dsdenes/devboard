import { Marked, type Tokens } from "marked";

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

/** Links may leave the console, but never into a script or data URL. */
function safeHref(href: string): boolean {
  if (/^\s*(?:javascript|data|vbscript):/i.test(href)) return false;
  return true;
}

const marked = new Marked({ gfm: true });

marked.use({
  renderer: {
    // A skill file is host content, not app markup: raw HTML renders as text.
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }: Tokens.Link) {
      const label = this.parser.parseInline(tokens);
      if (!safeHref(href)) return label;
      const titleAttribute = title == null ? "" : ` title="${escapeHtml(title)}"`;
      return `<a href="${escapeHtml(href)}"${titleAttribute} target="_blank" rel="noreferrer noopener">${label}</a>`;
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
  return marked.parse(body, { async: false });
}
