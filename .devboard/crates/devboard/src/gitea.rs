//! The Gitea REST calls the dashboard makes.

use serde_json::{json, Value};

/// One Gitea target: origin, `owner/name` project, and an optional token.
#[derive(Debug, Clone)]
pub struct GiteaTarget {
    pub base_url: String,
    pub project: String,
    pub token: Option<String>,
}

/// Why one request reached no HTTP response at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportFailure {
    /// The connection never opened, so nothing reached the forge and a retry
    /// cannot file a second issue.
    Connect,
    /// The attempt ran past its deadline before any answer arrived.
    Timeout,
    /// Any other transport failure: the forge may have received the request,
    /// so an automatic retry could duplicate it.
    Other,
}

impl TransportFailure {
    /// True when the forge answered nothing at all — an unreachable or slow
    /// upstream, never a failure this server produced.
    pub fn answered_nothing(self) -> bool {
        match self {
            Self::Connect | Self::Timeout => true,
            Self::Other => false,
        }
    }
}

/// One failure from the Gitea API.
#[derive(Debug, Clone)]
pub struct GiteaError {
    pub status: Option<u16>,
    pub message: String,
    /// Set when the request reached no HTTP response: the socket condition,
    /// not a refusal the forge itself produced.
    pub transport: Option<TransportFailure>,
}

impl std::fmt::Display for GiteaError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

/// A created issue.
#[derive(Debug, Clone)]
pub struct GiteaIssue {
    pub number: u64,
    pub title: String,
    pub url: String,
}

/// The API origin plus `/api/v1` for one target.
pub fn api_url(target: &GiteaTarget, path: &str) -> String {
    let suffix = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    format!("{}/api/v1{suffix}", target.base_url)
}

/// `/repos/<owner>/<name>` with each path segment encoded.
pub fn repo_path(target: &GiteaTarget) -> String {
    let segments: Vec<String> = target.project.split('/').map(encode_segment).collect();
    format!("/repos/{}", segments.join("/"))
}

/// The one segment encoding `encodeURIComponent` performs.
fn encode_segment(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        let unreserved = byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            );
        if unreserved {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// The first non-empty line of a failure body, or its `message` member.
fn message_from_body(body: &str) -> String {
    let first = body
        .split('\n')
        .map(str::trim)
        .find(|line| !line.is_empty());
    let Some(first) = first else {
        return "no response body".to_string();
    };
    if let Ok(parsed) = serde_json::from_str::<Value>(first) {
        if let Some(message) = parsed.get("message").and_then(Value::as_str) {
            return message.to_string();
        }
    }
    crate::feedback::truncate(first, 300)
}

/// One request the forge never answered, classified by its socket condition.
fn transport_error(error: reqwest::Error) -> GiteaError {
    let transport = if error.is_timeout() {
        TransportFailure::Timeout
    } else if error.is_connect() {
        TransportFailure::Connect
    } else {
        TransportFailure::Other
    };
    GiteaError {
        status: None,
        message: cause_chain(&error),
        transport: Some(transport),
    }
}

/// A client that could not be built sent nothing, so it carries no transport
/// classification.
fn client_error(error: reqwest::Error) -> GiteaError {
    GiteaError {
        status: None,
        message: cause_chain(&error),
        transport: None,
    }
}

/// The error's own line plus every distinct cause beneath it.
///
/// `reqwest` renders a failed send as `error sending request for url (…)`,
/// which names no cause at all; the socket answer below it — `Connection
/// refused`, `operation timed out` — is what makes the journal actionable.
fn cause_chain(error: &(dyn std::error::Error + 'static)) -> String {
    let mut parts = vec![error.to_string()];
    let mut cause = std::error::Error::source(error);
    while let Some(error) = cause {
        let text = error.to_string();
        if !text.is_empty() && !parts.iter().any(|part| part == &text) {
            parts.push(text);
        }
        cause = std::error::Error::source(error);
    }
    parts.join(": ")
}

/// Files one issue and returns it.
pub async fn create_issue(
    target: &GiteaTarget,
    title: &str,
    body: &str,
    flow_id: Option<&str>,
    timeout_ms: u64,
) -> Result<GiteaIssue, GiteaError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms.max(1)))
        .build()
        .map_err(client_error)?;
    let path = format!("{}/issues", repo_path(target));
    let mut request = client
        .post(api_url(target, &path))
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .body(crate::jsjson::stringify(
            &json!({"title": title, "body": body}),
        ));
    if let Some(flow_id) = flow_id {
        request = request.header("X-Flow-ID", flow_id);
    }
    if let Some(token) = target.token.as_deref().filter(|token| !token.is_empty()) {
        request = request.header("Authorization", format!("token {token}"));
    }
    let response = request.send().await.map_err(transport_error)?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(GiteaError {
            status: Some(status.as_u16()),
            message: format!(
                "POST {path} failed (HTTP {}): {}",
                status.as_u16(),
                message_from_body(&text)
            ),
            transport: None,
        });
    }
    let document: Value = serde_json::from_str(&text).map_err(|error| GiteaError {
        status: None,
        message: format!("POST {path} returned invalid JSON: {error}"),
        transport: None,
    })?;
    let number = document.get("number").and_then(Value::as_u64);
    let title = document.get("title").and_then(Value::as_str);
    let url = document.get("html_url").and_then(Value::as_str);
    match (number, title, url) {
        (Some(number), Some(title), Some(url)) => Ok(GiteaIssue {
            number,
            title: title.to_string(),
            url: url.to_string(),
        }),
        _ => Err(GiteaError {
            status: None,
            message: "the created issue has no number or URL".to_string(),
            transport: None,
        }),
    }
}

/// Adds one comment to an existing issue.
pub async fn comment_issue(
    target: &GiteaTarget,
    number: u64,
    body: &str,
    flow_id: Option<&str>,
    timeout_ms: u64,
) -> Result<(), GiteaError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms.max(1)))
        .build()
        .map_err(client_error)?;
    let path = format!("{}/issues/{number}/comments", repo_path(target));
    let mut request = client
        .post(api_url(target, &path))
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .body(crate::jsjson::stringify(&json!({"body": body})));
    if let Some(flow_id) = flow_id {
        request = request.header("X-Flow-ID", flow_id);
    }
    if let Some(token) = target.token.as_deref().filter(|token| !token.is_empty()) {
        request = request.header("Authorization", format!("token {token}"));
    }
    let response = request.send().await.map_err(transport_error)?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(GiteaError {
            status: Some(status.as_u16()),
            message: format!(
                "POST {path} failed (HTTP {}): {}",
                status.as_u16(),
                message_from_body(&text)
            ),
            transport: None,
        });
    }
    Ok(())
}

/// One issue's current state, or `None` when it could not be read.
pub async fn issue_state(
    target: &GiteaTarget,
    number: u64,
    timeout_ms: u64,
) -> Result<Option<bool>, GiteaError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms.max(1)))
        .build()
        .map_err(client_error)?;
    let path = format!("{}/issues/{number}", repo_path(target));
    let mut request = client
        .get(api_url(target, &path))
        .header("Accept", "application/json");
    if let Some(token) = target.token.as_deref().filter(|token| !token.is_empty()) {
        request = request.header("Authorization", format!("token {token}"));
    }
    let response = request.send().await.map_err(transport_error)?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(GiteaError {
            status: Some(status.as_u16()),
            message: format!(
                "GET {path} failed (HTTP {}): {}",
                status.as_u16(),
                message_from_body(&text)
            ),
            transport: None,
        });
    }
    let document: Value = serde_json::from_str(&text).map_err(|error| GiteaError {
        status: None,
        message: format!("GET {path} returned invalid JSON: {error}"),
        transport: None,
    })?;
    let state = document.get("state").and_then(Value::as_str);
    match state {
        Some(state) if state.eq_ignore_ascii_case("open") => Ok(Some(true)),
        Some(state) if state.eq_ignore_ascii_case("closed") => Ok(Some(false)),
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_api_and_repository_paths_are_built_like_the_client() {
        let target = GiteaTarget {
            base_url: "https://gitea.test".to_string(),
            project: "owner/name".to_string(),
            token: None,
        };
        assert_eq!(
            api_url(&target, "/repos/owner/name/issues"),
            "https://gitea.test/api/v1/repos/owner/name/issues"
        );
        assert_eq!(repo_path(&target), "/repos/owner/name");
    }
}
