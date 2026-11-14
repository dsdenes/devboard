//! The one rule deciding where a `SKILL.md` frontmatter block starts and ends.
//!
//! Three readers asked that question and two of them answered it differently:
//! the installed-skills page trimmed each line with ECMAScript's whitespace,
//! while Goal's skill inspection used Rust's `str::trim`, which does not treat
//! U+FEFF as whitespace. A skill document saved with a UTF-8 byte-order mark
//! therefore kept its row on the Skills page while Goal's inspection found no
//! frontmatter at all, so the skill left the prepared list and preparation's
//! contradiction review silently stopped covering it.
//!
//! Every reader — installed skills, Goal's inspection, the preparation
//! contradiction review, and the client's `skillBody` — uses the whitespace
//! definition below. It is ECMAScript's `String.prototype.trim`, which the
//! client already implements, so no reader may find a fence with Rust's
//! `str::trim`.

use std::collections::HashMap;

/// ECMAScript's whitespace and BOM, which `String.prototype.trim` removes.
pub fn is_js_space(character: char) -> bool {
    character == '\u{feff}' || character.is_whitespace()
}

/// ECMAScript's `String.prototype.trim`.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// Splits one document on `\r?\n`, each line with the byte offset it starts at.
fn split_lines(source: &str) -> Vec<(usize, &str)> {
    let bytes = source.as_bytes();
    let mut lines = Vec::new();
    let mut start = 0;
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\r' && index + 1 < bytes.len() && bytes[index + 1] == b'\n' {
            lines.push((start, &source[start..index]));
            index += 2;
            start = index;
        } else if bytes[index] == b'\n' {
            lines.push((start, &source[start..index]));
            index += 1;
            start = index;
        } else {
            index += 1;
        }
    }
    lines.push((start, &source[start..]));
    lines
}

/// The lines of one document, split as the frontmatter reader splits them.
pub fn lines(source: &str) -> Vec<&str> {
    split_lines(source)
        .into_iter()
        .map(|(_, line)| line)
        .collect()
}

/// The flat and one-level `metadata:` fields of a skill document's
/// frontmatter, or `None` when the document has no frontmatter block.
pub fn fields(source: &str) -> Option<HashMap<String, String>> {
    frontmatter(source).map(|(fields, _)| fields)
}

/// The document after its frontmatter block, or the whole document when it has
/// none.
pub fn body(source: &str) -> &str {
    frontmatter(source).map(|(_, body)| body).unwrap_or(source)
}

/// The frontmatter fields and the body that follows the closing fence.
fn frontmatter(source: &str) -> Option<(HashMap<String, String>, &str)> {
    let lines = split_lines(source);
    if !matches!(lines.first(), Some((_, line)) if js_trim(line) == "---") {
        return None;
    }
    let close = lines
        .iter()
        .enumerate()
        .skip(1)
        .find(|(_, (_, line))| js_trim(line) == "---")
        .map(|(index, _)| index)?;

    let fields = read_fields(&lines[1..close]);
    let (close_start, close_text) = lines[close];
    let mut body_start = close_start + close_text.len();
    for terminator in ["\r\n", "\n"] {
        if source[body_start..].starts_with(terminator) {
            body_start += terminator.len();
            break;
        }
    }
    Some((fields, &source[body_start..]))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum BlockStyle {
    Folded,
    Literal,
}

/// Reads the flat and one-level `metadata:` fields of a frontmatter block.
/// Folded (`>`) and literal (`|`) scalars are joined so a wrapped description
/// keeps its length and text.
fn read_fields(lines: &[(usize, &str)]) -> HashMap<String, String> {
    let mut fields: HashMap<String, String> = HashMap::new();
    let mut section: Option<String> = None;
    let mut block_key: Option<String> = None;
    let mut block_style = BlockStyle::Folded;
    let mut block_lines: Vec<String> = Vec::new();

    let mut flush_key: Option<(String, BlockStyle, Vec<String>)> = None;
    for (_, raw) in lines {
        let raw = *raw;
        let trimmed = js_trim(raw);

        if block_key.is_some() {
            if raw.starts_with(' ') || raw.starts_with('\t') {
                block_lines.push(trimmed.to_string());
                continue;
            }
            flush_key = block_key
                .take()
                .map(|key| (key, block_style, std::mem::take(&mut block_lines)));
        }

        if let Some((key, style, lines)) = flush_key.take() {
            fields.insert(key, join_block(style, lines));
        }

        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some(colon) = trimmed.find(':') else {
            continue;
        };
        if colon == 0 {
            continue;
        }
        let key = js_trim(&trimmed[..colon]).to_string();
        let value = trimmed[colon + 1..]
            .trim_start_matches(is_js_space)
            .to_string();

        if raw.chars().next().map(is_js_space).unwrap_or(false) {
            if let Some(section) = &section {
                fields.insert(format!("{section}.{key}"), unquote(&value));
                continue;
            }
        }

        let marker = js_trim(&value).to_string();
        if marker.is_empty() {
            section = Some(key);
            continue;
        }
        if marker == ">" || marker == ">-" || marker == "|" || marker == "|-" {
            section = None;
            block_key = Some(key);
            block_style = if marker.starts_with('>') {
                BlockStyle::Folded
            } else {
                BlockStyle::Literal
            };
            continue;
        }

        section = None;
        fields.insert(key, unquote(&value));
    }
    let tail = flush_key.take().or_else(|| {
        block_key
            .take()
            .map(|key| (key, block_style, std::mem::take(&mut block_lines)))
    });
    if let Some((key, style, lines)) = tail {
        fields.insert(key, join_block(style, lines));
    }
    fields
}

fn join_block(style: BlockStyle, lines: Vec<String>) -> String {
    if style == BlockStyle::Literal {
        lines.join("\n")
    } else {
        lines.join(" ")
    }
}

fn unquote(value: &str) -> String {
    let trimmed = js_trim(value);
    let characters: Vec<char> = trimmed.chars().collect();
    if characters.len() >= 2 {
        let first = characters[0];
        let last = characters[characters.len() - 1];
        if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
            return characters[1..characters.len() - 1].iter().collect();
        }
    }
    trimmed.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOM: &str = "\u{feff}";

    fn skill_document(prefix: &str, separator: &str) -> String {
        let mut source = [
            "---",
            "name: x",
            "description: Guidance for x.",
            "metadata:",
            "  devboard-managed: \"true\"",
            "---",
            "",
            "# X",
            "",
            "- Always keep the rule in one place.",
            "",
        ]
        .join(separator);
        source.insert_str(0, prefix);
        source
    }

    #[test]
    fn a_byte_order_mark_does_not_hide_the_fence() {
        let source = skill_document(BOM, "\n");
        let fields = fields(&source).expect("the frontmatter block");
        assert_eq!(fields.get("name").map(String::as_str), Some("x"));
        assert_eq!(
            fields.get("description").map(String::as_str),
            Some("Guidance for x.")
        );
        assert_eq!(
            fields.get("metadata.devboard-managed").map(String::as_str),
            Some("true")
        );
        assert_eq!(
            body(&source),
            "\n# X\n\n- Always keep the rule in one place.\n"
        );
    }

    #[test]
    fn crlf_and_the_mark_still_share_one_fence() {
        let source = skill_document(BOM, "\r\n");
        assert_eq!(
            fields(&source)
                .expect("the frontmatter block")
                .get("metadata.devboard-managed")
                .map(String::as_str),
            Some("true")
        );
        assert_eq!(
            body(&source),
            "\r\n# X\r\n\r\n- Always keep the rule in one place.\r\n"
        );
    }

    #[test]
    fn a_document_without_frontmatter_is_all_body() {
        let source = "# X\n\n- Always keep the rule in one place.\n";
        assert!(fields(source).is_none());
        assert_eq!(body(source), source);
    }

    #[test]
    fn an_unclosed_fence_is_not_a_frontmatter_block() {
        let source = "---\nname: x\n\n# X\n";
        assert!(fields(source).is_none());
        assert_eq!(body(source), source);
    }
}
