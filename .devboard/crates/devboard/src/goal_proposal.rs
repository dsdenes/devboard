//! Proposed-goal drafts: one Markdown file under `.devboard/goal-proposals/`.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::feedback::{
    captured_context, conversation_section, js_len, GoalProposalSubmission, RequestError,
};

/// Where a draft lives, relative to the repository root.
pub const GOAL_PROPOSALS_DIRECTORY: &str = ".devboard/goal-proposals";

/// The HTTP route that serves one draft.
pub const GOAL_PROPOSALS_ENDPOINT: &str = "/goal-proposals";

const MAX_HEADING: usize = 200;
const MAX_NAME_WORDS: usize = 6;
const MAX_SLUG_LENGTH: usize = 64;
const FALLBACK_NAME: &str = "ui-goal";
const UNPROCESSED_NOTICE: &str = "> Unprocessed draft. Elaborate it to turn it into a goal.";
const NO_CAPTURED_CONTEXT: &str = "No page context was captured.";
const MAX_NAME_ATTEMPTS: usize = 1000;

/// The report's first non-empty line, trimmed, or the empty string.
fn first_report_line(report: &str) -> &str {
    report
        .split('\n')
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
}

/// The heading text: one line, whitespace collapsed, bounded.
pub fn goal_proposal_heading(report: &str) -> String {
    let line = first_report_line(report)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    crate::feedback::js_truncate(&line, MAX_HEADING)
}

/// The deterministic fallback draft name.
pub fn goal_proposal_name(report: &str) -> String {
    let slug: String = {
        let lowered = first_report_line(report).to_lowercase();
        let mut out = String::new();
        let mut last_dash = false;
        for character in lowered.chars() {
            if character.is_ascii_alphanumeric() {
                out.push(character);
                last_dash = false;
            } else if !last_dash {
                out.push('-');
                last_dash = true;
            }
        }
        out.trim_matches('-').to_string()
    };
    let words: Vec<&str> = slug
        .split('-')
        .filter(|word| !word.is_empty())
        .take(MAX_NAME_WORDS)
        .collect();
    let name = words.join("-");
    if name.is_empty() {
        return FALLBACK_NAME.to_string();
    }
    if js_len(&name) <= MAX_SLUG_LENGTH {
        return name;
    }
    let cut = crate::feedback::js_truncate(&name, MAX_SLUG_LENGTH);
    cut.trim_end_matches('-').to_string()
}

/// The draft body: proposed goal, operator text, conversation, context.
pub fn goal_proposal_body(submission: &GoalProposalSubmission) -> String {
    let ask_turns = conversation_section(&submission.turns);
    let context = {
        let mut context = captured_context(&submission.captured);
        if context.is_empty() {
            context.push(NO_CAPTURED_CONTEXT.to_string());
        }
        context
    };
    let notice = context.len() == 1 && context[0] == NO_CAPTURED_CONTEXT;
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!(
        "# Proposed goal: {}",
        goal_proposal_heading(&submission.report)
    ));
    lines.push(String::new());
    if notice {
        lines.push(UNPROCESSED_NOTICE.to_string());
        lines.push(String::new());
    }
    lines.push(submission.report.clone());
    lines.push(String::new());
    if !ask_turns.is_empty() {
        lines.extend(ask_turns);
        lines.push(String::new());
    }
    lines.push("## Captured UI context".to_string());
    lines.push(String::new());
    lines.extend(context);
    lines.push(String::new());
    lines.join("\n")
}

/// Writes one draft under `<repo_dir>/.devboard/goal-proposals/`.
///
/// The request writes the draft from its own work: the name is derived from the
/// report, so no peer starts and no agent turn sits between the click and the
/// `201`. A naming turn used to run here and made the response wait for an ACP
/// spawn plus a model round trip.
pub async fn write_goal_proposal(
    submission: &GoalProposalSubmission,
    repo_dir: &Path,
    origin: Option<&str>,
) -> Result<Value, RequestError> {
    let directory = repo_dir.join(GOAL_PROPOSALS_DIRECTORY);
    std::fs::create_dir_all(&directory).map_err(|error| {
        RequestError::internal(format!("could not write the goal proposal: {error}"))
    })?;
    let name = goal_proposal_name(&submission.report);
    let body = goal_proposal_body(submission);
    let filename = create_exclusive(&directory, &name, &body)
        .await
        .map_err(|error| {
            RequestError::internal(format!("could not write the goal proposal: {error}"))
        })?;
    let href = match origin {
        Some(origin) => format!(
            "{}{}/{}",
            origin.trim_end_matches('/'),
            GOAL_PROPOSALS_ENDPOINT,
            encode_path_segment(&filename)
        ),
        None => file_url(&directory.join(&filename)),
    };
    Ok(json!({"links": {"draft": {"href": href}}}))
}

/// One URL path segment, percent-encoding everything outside the unreserved
/// set. Draft names are slugs, so this only guards the link grammar.
fn encode_path_segment(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// Writes the content to `name.md`, or the first free `name-N.md`.
async fn create_exclusive(directory: &Path, name: &str, content: &str) -> std::io::Result<String> {
    let temporary = directory.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
    let result = async {
        use tokio::io::AsyncWriteExt as _;
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .await?;
        file.write_all(content.as_bytes()).await?;
        file.flush().await?;
        drop(file);
        for index in 1..=MAX_NAME_ATTEMPTS {
            let filename = if index == 1 {
                format!("{name}.md")
            } else {
                format!("{name}-{index}.md")
            };
            match std::fs::hard_link(&temporary, directory.join(&filename)) {
                Ok(()) => return Ok(filename),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!("No free draft filename for {name}.md."),
        ))
    }
    .await;
    let _ = tokio::fs::remove_file(&temporary).await;
    result
}

/// The `file:` URL a draft link carries.
fn file_url(path: &Path) -> String {
    let absolute = std::path::absolute(path).unwrap_or_else(|_| PathBuf::from(path));
    let mut url = String::from("file://");
    let text = absolute.to_string_lossy();
    for byte in text.bytes() {
        let unsafe_byte = matches!(
            byte,
            b' ' | b'"' | b'#' | b'<' | b'>' | b'?' | b'`' | b'{' | b'}' | b'%'
        );
        if unsafe_byte {
            url.push_str(&format!("%{byte:02X}"));
        } else {
            url.push(byte as char);
        }
    }
    // Node's pathToFileURL leaves the leading slash of an absolute path in
    // place, so `file://` plus the path is `file:///...`.
    url
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::feedback::{CapturedFields, GoalProposalSubmission};

    #[test]
    fn a_draft_body_states_what_an_unprocessed_draft_is() {
        let submission = GoalProposalSubmission {
            report: "Make the header calm".to_string(),
            turns: Vec::new(),
            captured: CapturedFields::default(),
        };
        let body = goal_proposal_body(&submission);
        assert!(body.starts_with("# Proposed goal: Make the header calm\n\n"));
        assert!(body.contains(UNPROCESSED_NOTICE));
        assert!(body.contains("## Captured UI context"));
    }

    #[test]
    fn names_are_lowercase_hyphenated_and_bounded() {
        assert_eq!(
            goal_proposal_name("Make the Header Calm!"),
            "make-the-header-calm"
        );
        assert_eq!(goal_proposal_name(""), "ui-goal");
        assert_eq!(
            goal_proposal_name("one two three four five six seven"),
            "one-two-three-four-five-six"
        );
    }

    #[test]
    fn captured_context_reaches_the_draft() {
        let submission = GoalProposalSubmission {
            report: "x".to_string(),
            turns: Vec::new(),
            captured: CapturedFields {
                route: "/".to_string(),
                ..CapturedFields::default()
            },
        };
        let body = goal_proposal_body(&submission);
        assert!(!body.contains(UNPROCESSED_NOTICE));
        assert!(body.contains("- Route: `/`"));
    }
}
