//! Operator issue reporting payloads and the proposed-goal body.
//!
//! The validation messages are contract: every refusal is the same text the
//! TypeScript endpoint answers, so the corpus compares them.

use std::time::{Duration, Instant};

use serde_json::Value;

/// The repository that receives every reported UI issue.
pub const FEEDBACK_REPOSITORY: &str = "dsdenes/devboard";

pub const MAX_REPORT: usize = 8000;
pub const MAX_CONTEXT_FIELD: usize = 2000;
pub const MAX_DOM_EXCERPT: usize = 8000;
pub const MAX_VISIBLE_TEXT: usize = 8000;
pub const MAX_VIEWPORT: usize = 500;
pub const MAX_TITLE: usize = 200;
pub const TITLE_PREFIX: &str = "[ui] ";
pub const BODY_VISIBLE_TEXT: usize = 1500;
pub const MAX_CONVERSATION_TURNS: usize = 40;
pub const MAX_CONVERSATION_TURN: usize = 4000;
pub const MAX_CONVERSATION_TEXT: usize = 12_000;

pub const REMOVAL_INSTRUCTION: &str = "Remove the selected UI element from the interface.";
pub const REDESIGN_INSTRUCTION: &str =
    "Check the selected UI element and redesign it because it does not look good. Use the project \
     UI/UX skill (devboard-ui-ux) and this repository's DESIGN.md and design/tokens.json as the \
     normative design system.";

const ACTION_ERROR: &str = "action must be one of REPORT, REMOVE, REDESIGN.";

/// A payload the endpoint refuses with a client error.
#[derive(Debug, Clone)]
pub struct RequestError {
    pub status: u16,
    pub message: String,
    /// The failure's own text. The client reads `message`; only the journal
    /// records this, and it is `None` when `message` already names the cause.
    pub diagnostic: Option<String>,
    /// True when the forge answered nothing at all, so the failure is a
    /// delayed delivery rather than an error this server produced.
    pub transient: bool,
    /// True when the forge rejected the dashboard's configured credential, so
    /// reporting is misconfigured rather than this server failing.
    pub rejected_credential: bool,
}

impl RequestError {
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: 400,
            message: message.into(),
            diagnostic: None,
            transient: false,
            rejected_credential: false,
        }
    }

    /// An unexpected failure: the client sees one fixed detail and the
    /// exception line goes only to the journal.
    pub fn internal(message: impl Into<String>) -> Self {
        Self {
            status: 500,
            message: message.into(),
            diagnostic: None,
            transient: false,
            rejected_credential: false,
        }
    }

    /// Maps one failed delivery. The client keeps the fixed detail; the
    /// delivery's own text goes only to the journal.
    pub fn delivery(error: DeliveryError) -> Self {
        Self {
            status: error.status,
            message: error.message,
            diagnostic: Some(error.diagnostic),
            transient: error.transient,
            rejected_credential: error.rejected_credential,
        }
    }

    /// The line the journal records for this failure.
    pub fn journal_detail(&self) -> &str {
        self.diagnostic.as_deref().unwrap_or(&self.message)
    }
}

/// The JavaScript string length: UTF-16 code units.
pub fn js_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// Truncates to a JavaScript string length, at a character boundary.
pub fn js_truncate(value: &str, limit: usize) -> String {
    if js_len(value) <= limit {
        return value.to_string();
    }
    let mut used = 0;
    let mut out = String::new();
    for character in value.chars() {
        let width = character.len_utf16();
        if used + width > limit {
            break;
        }
        used += width;
        out.push(character);
    }
    out
}

/// One visible turn of the element-scoped Ask conversation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeedbackTurn {
    pub role: TurnRole,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnRole {
    Developer,
    Agent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeedbackAction {
    Report,
    Remove,
    Redesign,
}

/// The element context every browser request carries.
#[derive(Debug, Clone, Default)]
pub struct CapturedFields {
    pub route: String,
    pub url: String,
    pub selector: String,
    pub dom_excerpt: String,
    pub visible_text: String,
    pub viewport: String,
    pub captured_at: String,
}

/// One proposed-goal submission.
#[derive(Debug, Clone)]
pub struct GoalProposalSubmission {
    pub report: String,
    pub turns: Vec<FeedbackTurn>,
    pub captured: CapturedFields,
}

/// The body keys `POST /reports` accepts.
pub const FEEDBACK_BODY_KEYS: &[&str] = &[
    "action",
    "report",
    "turns",
    "route",
    "url",
    "selector",
    "dom_excerpt",
    "visible_text",
    "viewport",
    "captured_at",
];

/// The body keys `POST /goal-proposals` accepts.
pub const GOAL_PROPOSAL_BODY_KEYS: &[&str] = &[
    "report",
    "turns",
    "route",
    "url",
    "selector",
    "dom_excerpt",
    "visible_text",
    "viewport",
    "captured_at",
];

/// Refuses the first body key the endpoint does not accept.
pub fn reject_unknown_fields(
    source: &serde_json::Map<String, Value>,
    accepted: &[&str],
) -> Result<(), RequestError> {
    for key in source.keys() {
        if !accepted.contains(&key.as_str()) {
            return Err(RequestError::bad_request(format!("unknown field: {key}.")));
        }
    }
    Ok(())
}

/// Validates one optional or required string field under its bound.
fn field(
    source: &serde_json::Map<String, Value>,
    name: &str,
    wire: &str,
    limit: usize,
    required: bool,
) -> Result<String, RequestError> {
    let Some(value) = source.get(wire) else {
        if required {
            return Err(RequestError::bad_request(format!("{name} is required.")));
        }
        return Ok(String::new());
    };
    if value.is_null() {
        if required {
            return Err(RequestError::bad_request(format!("{name} is required.")));
        }
        return Ok(String::new());
    }
    let Some(text) = value.as_str() else {
        return Err(RequestError::bad_request(format!(
            "{name} must be a string."
        )));
    };
    if js_len(text) > limit {
        return Err(RequestError::bad_request(format!(
            "{name} is longer than {limit} characters."
        )));
    }
    if required && text.trim().is_empty() {
        return Err(RequestError::bad_request(format!(
            "{name} must not be empty."
        )));
    }
    Ok(text.to_string())
}

/// Whether a value is an RFC 3339 date-time in the accepted grammar.
fn is_rfc3339_date_time(value: &str) -> bool {
    let bytes = value.as_bytes();
    let digit = |index: usize| bytes.get(index).is_some_and(u8::is_ascii_digit);
    if bytes.len() < 20 || !digit(0) || !digit(1) || !digit(2) || !digit(3) || bytes[4] != b'-' {
        return false;
    }
    if !digit(5) || !digit(6) || bytes[7] != b'-' || !digit(8) || !digit(9) {
        return false;
    }
    if bytes[10] != b'T'
        || !digit(11)
        || !digit(12)
        || bytes[13] != b':'
        || !digit(14)
        || !digit(15)
    {
        return false;
    }
    if bytes[16] != b':' || !digit(17) || !digit(18) {
        return false;
    }
    let month: u32 = value[5..7].parse().unwrap_or(0);
    let day: u32 = value[8..10].parse().unwrap_or(0);
    let hour: u32 = value[11..13].parse().unwrap_or(99);
    let minute: u32 = value[14..16].parse().unwrap_or(99);
    let second: u32 = value[17..19].parse().unwrap_or(99);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || (second > 60)
    {
        return false;
    }
    let mut index = 19;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let start = index;
        while digit(index) {
            index += 1;
        }
        if index == start {
            return false;
        }
    }
    match bytes.get(index) {
        Some(b'Z') => index + 1 == bytes.len(),
        Some(b'+') | Some(b'-') => {
            let rest = &bytes[index + 1..];
            rest.len() == 5
                && rest[0].is_ascii_digit()
                && rest[1].is_ascii_digit()
                && rest[2] == b':'
                && rest[3].is_ascii_digit()
                && rest[4].is_ascii_digit()
                && rest[0] - b'0' <= 1
                && rest[1] - b'0' <= 9
                && rest[3] - b'0' <= 5
                && rest[4] - b'0' <= 9
        }
        _ => false,
    }
}

/// Validates the captured element context under the shared limits.
pub fn parse_captured_fields(
    source: &serde_json::Map<String, Value>,
) -> Result<CapturedFields, RequestError> {
    let captured_at = match source.get("captured_at") {
        None | Some(Value::Null) => String::new(),
        Some(_) => {
            let at = field(
                source,
                "captured_at",
                "captured_at",
                MAX_CONTEXT_FIELD,
                false,
            )?;
            if !is_rfc3339_date_time(&at) {
                return Err(RequestError::bad_request(
                    "captured_at must be an RFC 3339 date-time.",
                ));
            }
            at
        }
    };
    Ok(CapturedFields {
        route: field(source, "route", "route", MAX_CONTEXT_FIELD, false)?,
        url: field(source, "url", "url", MAX_CONTEXT_FIELD, false)?,
        selector: field(source, "selector", "selector", MAX_CONTEXT_FIELD, false)?,
        dom_excerpt: field(source, "dom_excerpt", "dom_excerpt", MAX_DOM_EXCERPT, false)?,
        visible_text: field(
            source,
            "visible_text",
            "visible_text",
            MAX_VISIBLE_TEXT,
            false,
        )?,
        viewport: field(source, "viewport", "viewport", MAX_VIEWPORT, false)?,
        captured_at,
    })
}

/// Validates the required free text under the shared report limit.
pub fn parse_report_text(value: Option<&Value>) -> Result<String, RequestError> {
    let mut source = serde_json::Map::new();
    if let Some(value) = value {
        source.insert("report".into(), value.clone());
    }
    field(&source, "report", "report", MAX_REPORT, true)
}

/// Validates the Ask turns.
pub fn parse_turns(value: Option<&Value>) -> Result<Vec<FeedbackTurn>, RequestError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    if value.is_null() {
        return Ok(Vec::new());
    }
    let Some(entries) = value.as_array() else {
        return Err(RequestError::bad_request("turns must be an array."));
    };
    if entries.len() > MAX_CONVERSATION_TURNS {
        return Err(RequestError::bad_request(format!(
            "turns has more than {MAX_CONVERSATION_TURNS} turns."
        )));
    }
    let mut turns = Vec::new();
    let mut total = 0;
    for (index, entry) in entries.iter().enumerate() {
        let Some(source) = entry.as_object() else {
            return Err(RequestError::bad_request(format!(
                "turns[{index}] must be an object."
            )));
        };
        let role = match source.get("role").and_then(Value::as_str) {
            Some("DEVELOPER") => TurnRole::Developer,
            Some("AGENT") => TurnRole::Agent,
            _ => {
                return Err(RequestError::bad_request(format!(
                    "turns[{index}].role must be DEVELOPER or AGENT."
                )))
            }
        };
        let name = format!("turns[{index}].text");
        let text = field(source, &name, "text", MAX_CONVERSATION_TURN, true)?;
        total += js_len(&text);
        turns.push(FeedbackTurn { role, text });
    }
    if total > MAX_CONVERSATION_TEXT {
        return Err(RequestError::bad_request(format!(
            "turns is longer than {MAX_CONVERSATION_TEXT} characters."
        )));
    }
    Ok(turns)
}

/// Validates one proposed-goal body, refusing any unknown key.
pub fn parse_goal_proposal_submission(
    value: &Value,
) -> Result<GoalProposalSubmission, RequestError> {
    let Some(source) = value.as_object() else {
        return Err(RequestError::bad_request(
            "The proposal must be a JSON object.",
        ));
    };
    reject_unknown_fields(source, GOAL_PROPOSAL_BODY_KEYS)?;
    Ok(GoalProposalSubmission {
        report: parse_report_text(source.get("report"))?,
        turns: parse_turns(source.get("turns"))?,
        captured: parse_captured_fields(source)?,
    })
}

/// Collapses whitespace and bounds the text with an ellipsis.
pub fn collapse(value: &str, limit: usize) -> String {
    let single = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if js_len(&single) <= limit {
        return single;
    }
    let mut cut = js_truncate(&single, limit.saturating_sub(1));
    while cut.ends_with(char::is_whitespace) {
        cut.pop();
    }
    format!("{cut}…")
}

/// Truncates with a trailing ellipsis.
pub fn truncate(value: &str, limit: usize) -> String {
    if js_len(value) <= limit {
        return value.to_string();
    }
    let mut cut = js_truncate(value, limit.saturating_sub(1));
    while cut.ends_with(char::is_whitespace) {
        cut.pop();
    }
    format!("{cut}…")
}

/// The first non-empty line, bounded to a diagnostic length.
pub fn first_line(value: &str) -> String {
    let line = value
        .split('\n')
        .map(str::trim)
        .find(|entry| !entry.is_empty())
        .unwrap_or("no diagnostic");
    truncate(line, 300)
}

/// The Ask conversation as Markdown, empty when no turn exists.
pub fn conversation_section(turns: &[FeedbackTurn]) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for turn in turns {
        lines.push(String::new());
        lines.push(format!(
            "**{}:**",
            match turn.role {
                TurnRole::Developer => "You",
                TurnRole::Agent => "Agent",
            }
        ));
        lines.push(String::new());
        lines.push(turn.text.trim().to_string());
    }
    if lines.is_empty() {
        return Vec::new();
    }
    let mut out = vec!["## Ask conversation".to_string()];
    out.extend(lines);
    out
}

/// The captured-context block shared by the draft and the issue body.
pub fn captured_context(captured: &CapturedFields) -> Vec<String> {
    let mut context: Vec<String> = Vec::new();
    for (label, value) in [
        ("Route", &captured.route),
        ("URL", &captured.url),
        ("Selected element", &captured.selector),
        ("Viewport", &captured.viewport),
        ("Captured at", &captured.captured_at),
    ] {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            context.push(format!("- {label}: `{}`", trimmed.replace('`', "'")));
        }
    }
    let visible = collapse(&captured.visible_text, BODY_VISIBLE_TEXT);
    if !visible.is_empty() {
        context.push(String::new());
        context.push("### Visible text".to_string());
        context.push(String::new());
        context.push(visible);
    }
    let dom = captured.dom_excerpt.trim();
    if !dom.is_empty() {
        let fence = if dom.contains("```") { "````" } else { "```" };
        context.push(String::new());
        context.push("### DOM excerpt".to_string());
        context.push(String::new());
        context.push(format!("{fence}html"));
        context.push(dom.to_string());
        context.push(fence.to_string());
    }
    context
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rfc3339_accepts_the_grammar_and_refuses_a_space() {
        assert!(is_rfc3339_date_time("2026-11-03T12:00:00Z"));
        assert!(is_rfc3339_date_time("2026-11-03T12:00:00.123+02:00"));
        assert!(!is_rfc3339_date_time("2026-11-03 12:00:00Z"));
        assert!(!is_rfc3339_date_time("2026-13-03T12:00:00Z"));
        assert!(!is_rfc3339_date_time("2026-11-03T12:00:00z"));
    }

    #[test]
    fn unknown_fields_are_refused_with_the_wire_name() {
        let value = json!({"report": "x", "nope": 1});
        let error = parse_goal_proposal_submission(&value).expect_err("refused");
        assert_eq!(error.message, "unknown field: nope.");
    }
}

/// One validated issue report.
#[derive(Debug, Clone)]
pub struct FeedbackSubmission {
    pub action: FeedbackAction,
    pub report: String,
    pub turns: Vec<FeedbackTurn>,
    pub captured: CapturedFields,
}

/// Validates the action field.
fn feedback_action(value: Option<&Value>) -> Result<FeedbackAction, RequestError> {
    match value {
        None | Some(Value::Null) => Ok(FeedbackAction::Report),
        Some(Value::String(action)) if action == "REPORT" => Ok(FeedbackAction::Report),
        Some(Value::String(action)) if action == "REMOVE" => Ok(FeedbackAction::Remove),
        Some(Value::String(action)) if action == "REDESIGN" => Ok(FeedbackAction::Redesign),
        _ => Err(RequestError::bad_request(ACTION_ERROR)),
    }
}

/// Validates one feedback body, refusing any unknown key.
pub fn parse_feedback_submission(value: &Value) -> Result<FeedbackSubmission, RequestError> {
    let Some(source) = value.as_object() else {
        return Err(RequestError::bad_request(
            "The report must be a JSON object.",
        ));
    };
    reject_unknown_fields(source, FEEDBACK_BODY_KEYS)?;
    let action = feedback_action(source.get("action"))?;
    Ok(FeedbackSubmission {
        action,
        report: if action == FeedbackAction::Report {
            parse_report_text(source.get("report"))?
        } else {
            String::new()
        },
        turns: parse_turns(source.get("turns"))?,
        captured: parse_captured_fields(source)?,
    })
}

/// One-line issue title for the submission's action.
pub fn feedback_title(submission: &FeedbackSubmission) -> String {
    if submission.action != FeedbackAction::Report {
        let label = if submission.action == FeedbackAction::Remove {
            "Remove element"
        } else {
            "Redesign element"
        };
        let selector = submission
            .captured
            .selector
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if selector.is_empty() {
            return format!("{TITLE_PREFIX}{label}");
        }
        return truncate(&format!("{TITLE_PREFIX}{label}: {selector}"), MAX_TITLE);
    }
    let line = submission
        .report
        .split('\n')
        .map(str::trim)
        .find(|value| !value.is_empty())
        .unwrap_or("operator report");
    truncate(
        &format!(
            "{TITLE_PREFIX}{}",
            line.split_whitespace().collect::<Vec<_>>().join(" ")
        ),
        MAX_TITLE,
    )
}

/// The ticket body: the request first, then conversation and context.
pub fn feedback_body(submission: &FeedbackSubmission) -> String {
    let request = match submission.action {
        FeedbackAction::Remove => vec![
            "## Removal request".to_string(),
            String::new(),
            REMOVAL_INSTRUCTION.to_string(),
        ],
        FeedbackAction::Redesign => vec![
            "## Redesign request".to_string(),
            String::new(),
            REDESIGN_INSTRUCTION.to_string(),
        ],
        FeedbackAction::Report => vec![
            "## Operator report".to_string(),
            String::new(),
            submission.report.trim().to_string(),
        ],
    };
    let mut lines = request;
    lines.push(String::new());
    let mut context = captured_context(&submission.captured);
    if context.is_empty() {
        context.push("No page context was captured.".to_string());
    }
    let ask_turns = conversation_section(&submission.turns);
    if !ask_turns.is_empty() {
        lines.extend(ask_turns);
        lines.push(String::new());
    }
    lines.push("## Captured UI context".to_string());
    lines.push(String::new());
    lines.extend(context);
    lines.join("\n")
}

/// The fixed Problem detail a failed delivery answers.
const DELIVERY_ERROR_DETAIL: &str = "The issue could not be filed.";

/// The fixed Problem detail a rejected credential answers.
///
/// The forge answered and refused the dashboard's own credential, so reporting
/// stays unavailable until the operator refreshes it: the same configuration
/// failure a missing `DEVBOARD_GITEA_URL` is, and never a server error the
/// watchdog files a defect for. The two keys are the ones `FeedbackConfig`
/// resolves, in its order.
pub const REJECTED_CREDENTIAL_DETAIL: &str = "Harness reporting is unavailable: the forge \
     rejected the reporting credential. Refresh GITEA_TOKEN (or DEVBOARD_GITEA_TOKEN) and restart \
     the dashboard.";

/// A delivery failure: the API refused the request, answered nothing, ran past
/// its deadline, or rejected the credential the dashboard was started with.
#[derive(Debug, Clone)]
pub struct DeliveryError {
    pub status: u16,
    pub message: String,
    pub diagnostic: String,
    /// True when the forge answered nothing at all — an unreachable or slow
    /// upstream, never a failure this server produced.
    pub transient: bool,
    /// True when the forge answered with an authentication failure: the
    /// dashboard's configured credential is refused, so no retry of this
    /// request can succeed and the operator owns the fix.
    pub rejected_credential: bool,
}

/// Files one report and returns the created issue document.
///
/// A connection that never opened is retried on the shared transient schedule,
/// because the forge never saw that request and a retry cannot file a second
/// issue. Every attempt and every pause stays inside `timeout_ms`, so the
/// endpoint's documented bound still holds.
pub async fn file_feedback_issue(
    submission: &FeedbackSubmission,
    target: &crate::gitea::GiteaTarget,
    flow_id: Option<&str>,
    timeout_ms: u64,
    sleep: &crate::forge::Sleep,
) -> Result<Value, DeliveryError> {
    let title = feedback_title(submission);
    let body = feedback_body(submission);
    let deadline = Instant::now() + Duration::from_millis(timeout_ms.max(1));
    let mut delays = crate::forge::FORGE_READ_RETRY_DELAYS_MS.iter().copied();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(timed_out(timeout_ms, None));
        }
        let attempt_timeout = remaining.as_millis().clamp(1, u128::from(u64::MAX)) as u64;
        let error =
            match crate::gitea::create_issue(target, &title, &body, flow_id, attempt_timeout).await
            {
                Ok(issue) => {
                    return Ok(serde_json::json!({
                        "title": title,
                        "links": {"issue": {"href": issue.url}},
                    }))
                }
                Err(error) => error,
            };
        if error.transport != Some(crate::gitea::TransportFailure::Connect) {
            return Err(delivery_error(error, timeout_ms));
        }
        let Some(delay) = delays.next() else {
            return Err(delivery_error(error, timeout_ms));
        };
        if deadline.saturating_duration_since(Instant::now()) <= Duration::from_millis(delay) {
            return Err(delivery_error(error, timeout_ms));
        }
        sleep(delay).await;
    }
}

/// One failed delivery, kept apart from the client's fixed detail.
fn delivery_error(error: crate::gitea::GiteaError, timeout_ms: u64) -> DeliveryError {
    match error.transport {
        Some(crate::gitea::TransportFailure::Timeout) => {
            timed_out(timeout_ms, Some(&error.message))
        }
        transport => {
            let rejected_credential = credential_rejected(error.status);
            DeliveryError {
                status: if rejected_credential { 503 } else { 502 },
                message: if rejected_credential {
                    REJECTED_CREDENTIAL_DETAIL.to_string()
                } else {
                    DELIVERY_ERROR_DETAIL.to_string()
                },
                diagnostic: format!("Issue creation failed: {}", first_line(&error.message)),
                transient: transport.is_some_and(crate::gitea::TransportFailure::answered_nothing),
                rejected_credential,
            }
        }
    }
}

/// True for the forge answers that refuse the dashboard's own credential: an
/// unauthenticated request and one the credential is not authorized for. Both
/// name a host credential the operator refreshes, never a fault the server can
/// retry away.
fn credential_rejected(status: Option<u16>) -> bool {
    matches!(status, Some(401) | Some(403))
}

/// One missed delivery deadline: the client reads the bound, the journal also
/// keeps the socket condition when the attempt named one.
fn timed_out(timeout_ms: u64, cause: Option<&str>) -> DeliveryError {
    let detail = format!("Issue creation timed out after {timeout_ms} ms.");
    let diagnostic = match cause {
        Some(cause) => format!("{detail} {}", first_line(cause)),
        None => detail.clone(),
    };
    DeliveryError {
        status: 504,
        message: detail,
        diagnostic,
        transient: true,
        rejected_credential: false,
    }
}
