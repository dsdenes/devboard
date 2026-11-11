//! ADR record listing.

use std::path::Path;

use serde_json::{json, Value};

/// The interface's one record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdrRecord {
    pub file: String,
    pub title: String,
    pub status: String,
    pub pending: bool,
    pub summary: String,
}

impl AdrRecord {
    pub fn to_json(&self) -> Value {
        json!({
            "file": self.file,
            "title": self.title,
            "status": self.status,
            "pending": self.pending,
            "summary": self.summary,
        })
    }
}

/// Reads the corpus and lists only the records it accepts, sorted by file.
pub fn read_records(directory: &Path) -> Result<(Vec<Value>, Value), String> {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((Vec::new(), Value::Null))
        }
        Err(error) => return Err(error.to_string()),
    };
    let mut records: Vec<AdrRecord> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("md") {
            continue;
        }
        let source = match crate::sampling::text(&path) {
            Some(text) => text,
            None => continue,
        };
        if let Some(record) = record_from_document(&path, &source) {
            records.push(record);
        }
    }
    records.sort_by(|left, right| left.file.cmp(&right.file));
    let next = records
        .iter()
        .find(|record| record.pending)
        .map(|record| Value::String(record.file.clone()))
        .unwrap_or(Value::Null);
    Ok((records.iter().map(AdrRecord::to_json).collect(), next))
}

/// Projects one Markdown record onto the interface contract.
fn record_from_document(path: &Path, source: &str) -> Option<AdrRecord> {
    let (frontmatter, body) = split_frontmatter(source)?;
    let title = frontmatter_value(frontmatter, "title")?;
    let status = frontmatter_value(frontmatter, "status").unwrap_or_default();
    let normalized = status.trim().to_lowercase();
    let file = path.file_name()?.to_string_lossy().into_owned();
    Some(AdrRecord {
        file,
        title,
        status: capitalize(&status),
        pending: normalized.is_empty() || normalized == "draft" || normalized == "proposed",
        summary: read_decision(body),
    })
}

/// Splits a document into its frontmatter block and its body.
fn split_frontmatter(source: &str) -> Option<(&str, &str)> {
    let mut lines = source.split_inclusive('\n');
    let first = lines.next()?;
    if first.trim_end() != "---" {
        return None;
    }
    let start = first.len();
    let mut offset = start;
    for line in lines {
        if line.trim_end() == "---" {
            let frontmatter = &source[start..offset];
            let body = &source[offset + line.len()..];
            return Some((frontmatter, body));
        }
        offset += line.len();
    }
    None
}

/// One top-level frontmatter value.
fn frontmatter_value(frontmatter: &str, key: &str) -> Option<String> {
    for line in frontmatter.lines() {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.trim() != key {
            continue;
        }
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|rest| rest.strip_suffix('"'))
            .unwrap_or(value);
        let value = value
            .strip_prefix('\'')
            .and_then(|rest| rest.strip_suffix('\''))
            .unwrap_or(value);
        return Some(value.to_string());
    }
    None
}

/// The capitalized status the interface renders.
fn capitalize(value: &str) -> String {
    let mut characters = value.chars();
    match characters.next() {
        Some(first) => first.to_uppercase().collect::<String>() + characters.as_str(),
        None => String::new(),
    }
}

/// The first paragraph under the record's Decision heading, shortened.
fn read_decision(body: &str) -> String {
    let mut in_decision = false;
    let mut started = false;
    let mut paragraph: Vec<&str> = Vec::new();
    for line in body.split('\n') {
        let trimmed = line.trim();
        if let Some(heading) = heading_text(trimmed) {
            if heading.eq_ignore_ascii_case("decision") {
                in_decision = true;
                continue;
            }
            if in_decision {
                break;
            }
            continue;
        }
        if !in_decision {
            continue;
        }
        if trimmed.is_empty() {
            if started {
                break;
            }
            continue;
        }
        started = true;
        paragraph.push(trimmed);
    }
    summarize_decision(&paragraph)
}

/// The text of an ATX heading line.
fn heading_text(line: &str) -> Option<&str> {
    let hashes = line
        .chars()
        .take_while(|character| *character == '#')
        .count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let rest = &line[hashes..];
    if !rest.starts_with(' ') {
        return None;
    }
    let text = rest.trim();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// Collapses the first decision paragraph to the short form.
fn summarize_decision(paragraph: &[&str]) -> String {
    if paragraph.is_empty() {
        return String::new();
    }
    let joined = paragraph.join(" ");
    let without_links = strip_markdown_links(&joined);
    let without_marks: String = without_links
        .chars()
        .filter(|character| !matches!(character, '`' | '*' | '_'))
        .collect();
    let without_bullet = without_marks
        .strip_prefix("- ")
        .or_else(|| without_marks.strip_prefix("+ "))
        .unwrap_or(&without_marks);
    let collapsed = without_bullet
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if collapsed.chars().count() <= 280 {
        return collapsed;
    }
    let mut cut: String = collapsed.chars().take(280).collect();
    if let Some(boundary) = cut.rfind(' ') {
        cut.truncate(boundary);
    }
    let cleaned = cut.trim_end_matches(['.', ',', ';', ':', '!', '?', '-']);
    format!("{cleaned}…")
}

/// Replaces `[text](target)` with `text`.
fn strip_markdown_links(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(open) = rest.find('[') {
        let Some(close) = rest[open..].find(']') else {
            break;
        };
        let after = open + close + 1;
        let Some(target) = rest[after..].strip_prefix('(') else {
            out.push_str(&rest[..=open]);
            rest = &rest[open + 1..];
            continue;
        };
        let Some(end) = target.find(')') else {
            out.push_str(&rest[..=open]);
            rest = &rest[open + 1..];
            continue;
        };
        out.push_str(&rest[..open]);
        out.push_str(&rest[open + 1..open + close]);
        rest = &rest[after + 1 + end + 1..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_record_projects_its_frontmatter_and_decision() {
        let source = concat!(
            "---\n",
            "id: \"0001\"\n",
            "title: Interface runtime\n",
            "status: accepted\n",
            "---\n",
            "# Interface runtime\n\n",
            "## Decision\n\n",
            "Use [TypeScript](https://example.test) on `Bun`.\n\nSecond paragraph.\n",
        );
        let record = record_from_document(Path::new("/x/0001-a.md"), source).expect("a record");
        assert_eq!(record.file, "0001-a.md");
        assert_eq!(record.title, "Interface runtime");
        assert_eq!(record.status, "Accepted");
        assert!(!record.pending);
        assert_eq!(record.summary, "Use TypeScript on Bun.");
    }

    #[test]
    fn a_pending_status_in_any_case_is_pending_and_named_next() {
        let root = records_fixture_dir("mixed-case");
        write_record(
            &root,
            "0001-proposed.md",
            "Proposed record",
            Some("Proposed"),
        );
        write_record(&root, "0002-draft.md", "Draft record", Some("Draft"));
        write_record(
            &root,
            "0003-accepted.md",
            "Accepted record",
            Some("Accepted"),
        );
        let (records, next) = read_records(&root).expect("records");
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(records.len(), 3);
        assert_eq!(records[0]["status"], "Proposed");
        assert_eq!(records[0]["pending"], true);
        assert_eq!(records[1]["status"], "Draft");
        assert_eq!(records[1]["pending"], true);
        assert_eq!(records[2]["status"], "Accepted");
        assert_eq!(records[2]["pending"], false);
        assert_eq!(next, Value::String("0001-proposed.md".to_string()));
    }

    #[test]
    fn a_record_without_a_status_is_listed_as_pending() {
        let root = records_fixture_dir("no-status");
        write_record(&root, "0001-unset.md", "Unset record", None);
        let (records, next) = read_records(&root).expect("records");
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["status"], "");
        assert_eq!(records[0]["pending"], true);
        assert_eq!(next, Value::String("0001-unset.md".to_string()));
    }

    fn records_fixture_dir(label: &str) -> std::path::PathBuf {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!("records-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("a fixture root");
        root
    }

    fn write_record(directory: &Path, file: &str, title: &str, status: Option<&str>) {
        let status = status
            .map(|value| format!("status: {value}\n"))
            .unwrap_or_default();
        let source =
            format!("---\ntitle: {title}\n{status}---\n# {title}\n\n## Decision\n\nDecide.\n");
        std::fs::write(directory.join(file), source).expect("a fixture record");
    }

    #[test]
    fn an_absent_directory_is_an_empty_set() {
        let (records, next) =
            read_records(Path::new("/nonexistent-devboard-records")).expect("empty");
        assert!(records.is_empty());
        assert_eq!(next, Value::Null);
    }
}
