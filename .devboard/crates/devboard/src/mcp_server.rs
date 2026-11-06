//! The Devboard stdio MCP server.
//!
//! Only JSON-RPC messages reach stdout; diagnostics go to stderr. The server
//! answers initialize, tools/list, and tools/call, exits cleanly on stdin EOF,
//! and starts no HTTP listener.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

use crate::agent_sessions::{self, ListSessionsOptions};
use crate::forge::{
    CloseReason, CommentTarget, CreateForgeIssueInput, ForgeIssueDocument, ForgeIssuesClient,
    ForgeIssuesOptions, IssueQueryState,
};
use crate::text_budget::bound_bytes;

pub const SERVER_NAME: &str = "devboard";
pub const PROTOCOL_VERSION: &str = "2024-11-05";

const GOAL_TEXT_MAX_BYTES: usize = 64 * 1024;
const GOAL_TITLE_MAX: usize = 200;
const GOAL_SECTION_HEADINGS: [&str; 5] = [
    "Objective",
    "Success criteria",
    "Verification",
    "Boundaries",
    "Stop conditions",
];
const ISSUE_BODY_MAX_BYTES: usize = 64 * 1024;
const ISSUE_LIST_MAX: usize = 200;
const ISSUE_TITLE_MAX_BYTES: usize = 255;

pub const VERIFICATION_TIMEOUT_MS: u64 = 900_000;
pub const VERIFICATION_OUTPUT_MAX_BYTES: usize = 16 * 1024;
pub const VERIFICATION_PATH_MAX: usize = 50;

pub const JOURNAL_SEARCH_MAX_RECORDS: usize = 200;
pub const JOURNAL_SEARCH_MAX_BYTES: usize = 64 * 1024;

const AGENT_IDS: [&str; 9] = [
    "scout",
    "watchdog",
    "design",
    "dead-code",
    "mcp-optimizer",
    "api-standards",
    "single-responsibility",
    "consistent-naming",
    "release-train",
];

const FLOW_CATEGORIES: [&str; 7] = [
    "contract",
    "entity",
    "naming",
    "data",
    "dependency",
    "irreversible",
    "structure",
];

const DISCOVER_SKILL_NAMES: [&str; 6] = [
    "discover-architecture-boundaries",
    "discover-contribution",
    "discover-coding-conventions",
    "discover-glossary",
    "discover-naming-conventions",
    "discover-testing-strategy",
];

const ENTRY_POINT_SURFACES: [&str; 5] = [
    "scout",
    "design",
    "dead-code",
    "single-responsibility",
    "consistent-naming",
];

/// The MCP server's resolved roots. Every path argument is judged against
/// them; nothing is read or written outside.
#[derive(Clone)]
pub struct McpContext {
    pub repo_dir: PathBuf,
    pub harness_dir: PathBuf,
    pub state_dir: PathBuf,
    pub environment: HashMap<String, String>,
    /// Test seam: the live dashboards a request must use instead of discovery.
    pub dashboards: Option<Vec<LiveDashboard>>,
}

#[derive(Clone, Debug)]
pub struct LiveDashboard {
    pub pid: u32,
    pub port: u16,
    pub repo_dir: String,
    pub harness: String,
    pub state_dir: String,
}

/// A path argument that cannot leave one allowed root.
#[derive(Debug, Clone)]
pub struct PathRefusal(pub String);

impl std::fmt::Display for PathRefusal {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for PathRefusal {}

// ---------------------------------------------------------------------------
// Context resolution
// ---------------------------------------------------------------------------

fn git_top_level(directory: &Path) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(directory)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let top = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!top.is_empty()).then_some(top)
}

fn resolve_path(path: &Path) -> PathBuf {
    agent_sessions::resolve_path(path)
}

/// The roots a stdio server works from, exactly as the TS `resolveContext`.
pub fn resolve_context() -> McpContext {
    let environment: HashMap<String, String> = std::env::vars().collect();
    let cwd = std::env::current_dir().unwrap_or_default();
    let repo_dir = resolve_path(
        &environment
            .get("REPO_DIR")
            .map(PathBuf::from)
            .or_else(|| git_top_level(&cwd).map(PathBuf::from))
            .unwrap_or(cwd),
    );
    let harness = environment
        .get("DEVBOARD_HARNESS_DIR")
        .filter(|value| !value.is_empty())
        .map(|value| resolve_path(Path::new(value)))
        .unwrap_or_else(|| crate::version::host_harness_dir(&repo_dir));
    let state_dir = environment
        .get("STATE_DIR")
        .map(|value| resolve_path(Path::new(value)))
        .unwrap_or_else(|| repo_dir.join(".devboard").join(".tmp"));
    McpContext {
        repo_dir,
        harness_dir: harness,
        state_dir,
        environment,
        dashboards: None,
    }
}

// ---------------------------------------------------------------------------
// Dashboard discovery and commands
// ---------------------------------------------------------------------------

fn real_path(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| resolve_path(path))
}

/// Every live dashboard serving exactly this repository.
pub fn discover_dashboards(repo_dir: &Path) -> Vec<LiveDashboard> {
    let target = real_path(repo_dir);
    let mut found: Vec<LiveDashboard> = crate::workers::watchdog::discover_instances_for(repo_dir)
        .into_iter()
        .filter(|instance| real_path(Path::new(&instance.repo_dir)) == target)
        .map(|instance| LiveDashboard {
            pid: instance.pid,
            port: u16::try_from(instance.port).unwrap_or(0),
            repo_dir: instance.repo_dir,
            harness: instance.harness,
            state_dir: instance.state_dir,
        })
        .collect();
    found.sort_by_key(|dashboard| dashboard.port);
    found
}

fn dashboards_for(context: &McpContext) -> Vec<LiveDashboard> {
    context
        .dashboards
        .clone()
        .unwrap_or_else(|| discover_dashboards(&context.repo_dir))
}

/// The single dashboard, or a refusal naming the repository and ports.
fn select_dashboard(context: &McpContext) -> Result<LiveDashboard, String> {
    let found = dashboards_for(context);
    let repo = context.repo_dir.to_string_lossy();
    if found.is_empty() {
        return Err(format!(
            "No live dashboard serves {repo}; start one before using a control tool."
        ));
    }
    if found.len() > 1 {
        let ports: Vec<String> = found.iter().map(|entry| entry.port.to_string()).collect();
        return Err(format!(
            "{} live dashboards serve {repo} (ports {}); refusing to guess which one to command.",
            found.len(),
            ports.join(", ")
        ));
    }
    Ok(found[0].clone())
}

fn command_json(command: &Value) -> String {
    crate::jsjson::stringify(command)
}

/// Opens the dashboard's WebSocket, lets its connect-time replay settle, sends
/// one command, and resolves the first reply that `accept` names or an error.
async fn dashboard_command(
    dashboard: &LiveDashboard,
    command: Value,
    accept: impl Fn(&Value) -> bool,
    timeout_ms: u64,
) -> Result<Value, String> {
    let port = dashboard.port;
    let request = format!("ws://127.0.0.1:{port}/ws")
        .into_client_request()
        .map_err(|_| format!("the dashboard on port {port} refused the connection"))?;
    let commands: Vec<Value> = match command {
        Value::Array(entries) => entries,
        other => vec![other],
    };
    let connect = tokio_tungstenite::connect_async(request);
    let socket = tokio::time::timeout(Duration::from_millis(timeout_ms), connect)
        .await
        .map_err(|_| format!("the dashboard on port {port} did not answer in time"))?
        .map_err(|_| format!("the dashboard on port {port} refused the connection"))?
        .0;
    let (mut sink, mut stream) = socket.split();
    use futures_util::{SinkExt, StreamExt};
    tokio::time::sleep(Duration::from_millis(250)).await;
    for entry in &commands {
        sink.send(Message::Text(command_json(entry).into()))
            .await
            .map_err(|_| format!("the dashboard on port {port} refused the connection"))?;
    }
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    let mut accepted: Option<Value> = None;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            let _ = sink.close().await;
            return Err(format!(
                "the dashboard on port {port} did not answer in time"
            ));
        }
        let read = tokio::time::timeout(remaining, stream.next()).await;
        let frame = match read {
            Err(_) => {
                let _ = sink.close().await;
                return Err(format!(
                    "the dashboard on port {port} did not answer in time"
                ));
            }
            Ok(None) => {
                let _ = sink.close().await;
                return Err(format!(
                    "the dashboard on port {port} refused the connection"
                ));
            }
            Ok(Some(Err(_))) => {
                let _ = sink.close().await;
                return Err(format!(
                    "the dashboard on port {port} refused the connection"
                ));
            }
            Ok(Some(Ok(frame))) => frame,
        };
        let text = match frame {
            Message::Text(text) => text.as_str().to_string(),
            Message::Binary(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Message::Close(_) => {
                let _ = sink.close().await;
                return Err(format!(
                    "the dashboard on port {port} refused the connection"
                ));
            }
            _ => continue,
        };
        let Ok(reply) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let Some(record) = reply.as_object() else {
            continue;
        };
        let Some(kind) = record.get("type").and_then(Value::as_str) else {
            continue;
        };
        if kind == "error" {
            let message = record
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("the dashboard refused the command");
            let _ = sink.close().await;
            return Err(message.to_string());
        }
        if accepted.is_some() {
            continue;
        }
        if accept(&reply) {
            accepted = Some(reply);
            // The dashboard can publish the new state and then refuse the
            // command; give the refusal a moment to arrive before succeeding.
            let grace = tokio::time::Instant::now() + Duration::from_millis(50);
            while let Some(remaining) = grace.checked_duration_since(tokio::time::Instant::now()) {
                match tokio::time::timeout(remaining, stream.next()).await {
                    Ok(Some(Ok(Message::Text(text)))) => {
                        if let Ok(Value::Object(record)) =
                            serde_json::from_str::<Value>(text.as_str())
                        {
                            if record.get("type").and_then(Value::as_str) == Some("error") {
                                let message = record
                                    .get("message")
                                    .and_then(Value::as_str)
                                    .unwrap_or("the dashboard refused the command");
                                let _ = sink.close().await;
                                return Err(message.to_string());
                            }
                        }
                    }
                    Ok(Some(Ok(_))) => continue,
                    Ok(Some(Err(_))) | Ok(None) => break,
                    Err(_) => break,
                }
            }
            let reply = accepted.take().unwrap_or(Value::Null);
            let _ = sink.close().await;
            return Ok(reply);
        }
    }
}

fn strip_type(reply: &Value) -> Value {
    let mut result = Map::new();
    if let Some(record) = reply.as_object() {
        for (key, value) in record {
            if key == "type" {
                continue;
            }
            result.insert(key.clone(), value.clone());
        }
    }
    Value::Object(result)
}

// ---------------------------------------------------------------------------
// JSON-RPC framing
// ---------------------------------------------------------------------------

fn response(id: Option<&Value>, result: Value) -> String {
    let mut record = Map::new();
    record.insert("jsonrpc".into(), json!("2.0"));
    if let Some(id) = id {
        record.insert("id".into(), id.clone());
    }
    record.insert("result".into(), result);
    format!("{}\n", crate::jsjson::stringify(&Value::Object(record)))
}

fn failure(id: Option<&Value>, code: i64, message: &str) -> String {
    let mut record = Map::new();
    record.insert("jsonrpc".into(), json!("2.0"));
    if let Some(id) = id {
        record.insert("id".into(), id.clone());
    }
    record.insert("error".into(), json!({"code": code, "message": message}));
    format!("{}\n", crate::jsjson::stringify(&Value::Object(record)))
}

fn tool_text(value: &Value, context: &McpContext) -> String {
    let pretty = serde_json::to_string_pretty(value).unwrap_or_default();
    let pairs: Vec<(String, String)> = context
        .environment
        .iter()
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();
    crate::redact::redact_secrets(&pretty, &pairs, &[])
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => crate::jsjson::number_f64(value.as_f64().unwrap_or(0.0)),
        Value::String(value) => value.clone(),
        Value::Array(values) => values.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// One parsed JSON-RPC request line.
async fn handle_line(line: &str, context: &McpContext) -> Option<String> {
    let parsed: Value = match serde_json::from_str(line) {
        Ok(parsed) => parsed,
        Err(_) => return Some(failure(Some(&Value::Null), -32700, "Parse error")),
    };
    let Some(request) = parsed.as_object() else {
        return Some(failure(Some(&Value::Null), -32600, "Invalid Request"));
    };
    if parsed.is_array() {
        return Some(failure(Some(&Value::Null), -32600, "Invalid Request"));
    }
    let id = request.get("id").cloned();
    let notification = id.is_none();
    let method = match request.get("method").and_then(Value::as_str) {
        Some(method) => method,
        None => {
            return if notification {
                None
            } else {
                Some(failure(id.as_ref(), -32600, "Invalid Request"))
            }
        }
    };
    if method.starts_with("notifications/") {
        return None;
    }
    if method == "initialize" {
        let params = request
            .get("params")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let requested = params.get("protocolVersion").and_then(Value::as_str);
        let protocol_version = match requested {
            Some(value) if !value.is_empty() => value.to_string(),
            _ => PROTOCOL_VERSION.to_string(),
        };
        let version = crate::version::read_harness_version(&context.harness_dir)
            .unwrap_or_else(|| "0.0.0".to_string());
        return Some(response(
            id.as_ref(),
            json!({
                "protocolVersion": protocol_version,
                "capabilities": {"tools": {"listChanged": false}},
                "serverInfo": {"name": SERVER_NAME, "version": version},
            }),
        ));
    }
    if method == "ping" {
        return if notification {
            None
        } else {
            Some(response(id.as_ref(), json!({})))
        };
    }
    if method == "tools/list" {
        return Some(response(id.as_ref(), crate::mcp::tool_list_payload()));
    }
    if method == "tools/call" {
        let params = request
            .get("params")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        if let Some(name) = params.get("name").and_then(Value::as_str) {
            if tool_definition(name).is_some() {
                let _ = record_tool_invocation(&context.state_dir, &context.repo_dir, name);
            }
        }
        let result = call_tool(context, params.get("name"), params.get("arguments")).await;
        if let Some(error) = result.get("error").and_then(Value::as_str) {
            return Some(response(
                id.as_ref(),
                json!({
                    "content": [{"type": "text", "text": tool_text(&json!({"error": error}), context)}],
                    "isError": true,
                }),
            ));
        }
        let value = result.get("value").cloned().unwrap_or(Value::Null);
        return Some(response(
            id.as_ref(),
            json!({"content": [{"type": "text", "text": tool_text(&value, context)}]}),
        ));
    }
    if notification {
        None
    } else {
        Some(failure(
            id.as_ref(),
            -32601,
            &format!("Method not found: {method}"),
        ))
    }
}

/// The whole stdio loop; returns at stdin EOF.
pub async fn run_stdio<R, W, D>(
    context: McpContext,
    input: R,
    mut output: W,
    mut diagnostics: D,
) -> anyhow::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    D: AsyncWrite + Unpin,
{
    let mut lines = BufReader::new(input).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                if let Some(reply) = handle_line(line, &context).await {
                    output.write_all(reply.as_bytes()).await?;
                    output.flush().await?;
                }
            }
            Ok(None) => break,
            Err(error) => {
                let _ = diagnostics
                    .write_all(format!("{SERVER_NAME}: {error}\n").as_bytes())
                    .await;
                break;
            }
        }
    }
    Ok(())
}

/// The `devboard mcp` entry point.
pub async fn run_server() -> anyhow::Result<()> {
    let context = resolve_context();
    run_stdio(
        context,
        tokio::io::stdin(),
        tokio::io::stdout(),
        tokio::io::stderr(),
    )
    .await
}

// ---------------------------------------------------------------------------
// Catalog lookup and invocation counters
// ---------------------------------------------------------------------------

fn tool_definition(name: &str) -> Option<Value> {
    crate::mcp::tool_list_payload()
        .get("tools")
        .and_then(Value::as_array)?
        .iter()
        .find(|tool| tool.get("name").and_then(Value::as_str) == Some(name))
        .cloned()
}

fn record_tool_invocation(state_dir: &Path, repo_dir: &Path, name: &str) -> Result<(), ()> {
    if name.is_empty() {
        return Ok(());
    }
    use rusqlite::Connection;
    let path = crate::mcp::tool_invocation_file(state_dir, repo_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| ())?;
    }
    let database = Connection::open(&path).map_err(|_| ())?;
    database
        .busy_timeout(Duration::from_millis(5_000))
        .map_err(|_| ())?;
    database
        .execute(
            "CREATE TABLE IF NOT EXISTS tool_invocations (name TEXT PRIMARY KEY NOT NULL, count INTEGER NOT NULL)",
            [],
        )
        .map_err(|_| ())?;
    database
        .execute(
            "INSERT INTO tool_invocations (name, count) VALUES (?1, 1) \
             ON CONFLICT(name) DO UPDATE SET count = count + 1",
            [name],
        )
        .map_err(|_| ())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

fn type_matches(value: &Value, kind: &Value) -> bool {
    if let Some(kinds) = kind.as_array() {
        return kinds.iter().any(|entry| type_matches(value, entry));
    }
    let Some(kind) = kind.as_str() else {
        return true;
    };
    match kind {
        "string" => value.is_string(),
        "integer" => value
            .as_f64()
            .map(|number| number.is_finite() && number.fract() == 0.0)
            .unwrap_or(false),
        "number" => value.as_f64().map(f64::is_finite).unwrap_or(false),
        "boolean" => value.is_boolean(),
        "array" => value.is_array(),
        "object" => value.is_object(),
        "null" => value.is_null(),
        _ => true,
    }
}

fn same_value(left: &Value, right: &Value) -> bool {
    match (left.as_f64(), right.as_f64()) {
        (Some(left), Some(right)) => left == right,
        _ => left == right,
    }
}

fn validate_arguments(schema: &Value, value: &Value, path: &str) -> Option<String> {
    if let Some(kind) = schema.get("type") {
        if !type_matches(value, kind) {
            let expected = crate::jsjson::stringify(kind);
            return Some(format!("{path} does not match type {expected}."));
        }
    }
    if let Some(allowed) = schema.get("enum").and_then(Value::as_array) {
        if !allowed.iter().any(|entry| same_value(entry, value)) {
            let names: Vec<String> = allowed.iter().map(js_string).collect();
            return Some(format!("{path} must be one of {}.", names.join(", ")));
        }
    }
    if let Some(number) = value.as_f64() {
        if let Some(minimum) = schema.get("minimum").and_then(Value::as_f64) {
            if number < minimum {
                return Some(format!(
                    "{path} must be at least {}.",
                    js_number_text(minimum)
                ));
            }
        }
        if let Some(maximum) = schema.get("maximum").and_then(Value::as_f64) {
            if number > maximum {
                return Some(format!(
                    "{path} must be at most {}.",
                    js_number_text(maximum)
                ));
            }
        }
    }
    if let Some(entries) = value.as_array() {
        if let Some(minimum) = schema.get("minItems").and_then(Value::as_u64) {
            if (entries.len() as u64) < minimum {
                return Some(format!("{path} must hold at least {minimum} item(s)."));
            }
        }
        if let Some(maximum) = schema.get("maxItems").and_then(Value::as_u64) {
            if (entries.len() as u64) > maximum {
                return Some(format!("{path} must hold at most {maximum} item(s)."));
            }
        }
        if let Some(items) = schema.get("items") {
            if items.is_object() {
                for (index, entry) in entries.iter().enumerate() {
                    if let Some(detail) =
                        validate_arguments(items, entry, &format!("{path}[{index}]"))
                    {
                        return Some(detail);
                    }
                }
            }
        }
        return None;
    }
    if let Some(record) = value.as_object() {
        let properties = schema
            .get("properties")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        if let Some(required) = schema.get("required").and_then(Value::as_array) {
            for key in required {
                if let Some(key) = key.as_str() {
                    if !record.contains_key(key) {
                        return Some(format!("{path}.{key} is required."));
                    }
                }
            }
        }
        if schema.get("additionalProperties").and_then(Value::as_bool) == Some(false) {
            if let Some(unknown) = record.keys().find(|key| !properties.contains_key(*key)) {
                return Some(format!("{path}.{unknown} is not allowed."));
            }
        }
        for (key, entry) in record {
            let Some(property) = properties.get(key) else {
                continue;
            };
            if !property.is_object() {
                continue;
            }
            if let Some(detail) = validate_arguments(property, entry, &format!("{path}.{key}")) {
                return Some(detail);
            }
        }
    }
    None
}

fn js_number_text(number: f64) -> String {
    crate::jsjson::number_f64(number)
}

fn mutating_tool(name: &str) -> bool {
    matches!(
        name,
        "background_agent_control"
            | "mcp_optimizer_proposal_skip"
            | "design_release_request"
            | "discover_contribution_stage"
            | "discover_glossary_stage"
            | "discover_sheet_stage"
            | "discover_significance_stage"
            | "discover_skill_stage"
            | "flow_checkpoint_record"
            | "flow_control"
            | "flow_steering_ack"
            | "flow_verification_record"
            | "flow_widgets_register"
            | "goal_control"
            | "goal_draft_file"
            | "goal_spec_write"
            | "issue_close"
            | "issue_comment"
            | "issue_create"
            | "issues_control"
            | "lifecycle_control"
            | "watchdog_duplicate_record"
    )
}

fn string_argument(args: &Map<String, Value>, name: &str) -> Result<String, String> {
    match args.get(name) {
        Some(Value::String(value)) if !value.is_empty() => Ok(value.clone()),
        _ => Err(format!("{name} must be a non-empty string.")),
    }
}

fn optional_string(args: &Map<String, Value>, name: &str) -> Result<Option<String>, String> {
    match args.get(name) {
        None => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(format!("{name} must be a string.")),
    }
}

fn number_argument(args: &Map<String, Value>, name: &str) -> Option<f64> {
    args.get(name).and_then(Value::as_f64)
}

fn positive_issue_number(value: Option<&Value>) -> Result<i64, String> {
    match value.and_then(Value::as_f64) {
        Some(number) if number.is_finite() && number.fract() == 0.0 && number > 0.0 => {
            Ok(number as i64)
        }
        _ => Err("number must be a positive issue number.".to_string()),
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn now_iso() -> String {
    agent_sessions::iso_from_millis(now_millis())
}

fn environment_value<'a>(context: &'a McpContext, key: &str) -> Option<&'a str> {
    context.environment.get(key).map(String::as_str)
}

/// The path arguments of one tool call pass these roots or are refused.
fn resolve_contained(
    root: &Path,
    value: Option<&Value>,
    label: &str,
    must_exist: bool,
) -> Result<(PathBuf, String), String> {
    let Some(text) = value.and_then(Value::as_str) else {
        return Err(format!(
            "{label} must be a non-empty repository-relative path."
        ));
    };
    if text.is_empty() {
        return Err(format!(
            "{label} must be a non-empty repository-relative path."
        ));
    }
    let normalized = text.replace('\\', "/");
    let windows_absolute = normalized.len() > 2
        && normalized.as_bytes()[0].is_ascii_alphabetic()
        && normalized.as_bytes()[1] == b':'
        && normalized.as_bytes()[2] == b'/';
    if normalized.starts_with('/') || windows_absolute {
        return Err(format!(
            "{label} must be relative, not absolute: {normalized}"
        ));
    }
    if normalized.split('/').any(|part| part == "..") {
        return Err(format!("{label} must not contain \"..\": {normalized}"));
    }
    let absolute_root = resolve_path(root);
    let absolute = resolve_path(&absolute_root.join(&normalized));
    if !absolute.starts_with(&absolute_root) {
        return Err(format!("{label} leaves its root: {normalized}"));
    }
    let Some(root_real) = std::fs::canonicalize(&absolute_root).ok() else {
        return Err(format!(
            "{label} root does not exist: {}",
            absolute_root.to_string_lossy()
        ));
    };
    let mut probe = absolute.clone();
    loop {
        if let Ok(real) = std::fs::canonicalize(&probe) {
            if !real.starts_with(&root_real) {
                return Err(format!("{label} resolves outside its root: {normalized}"));
            }
            break;
        }
        match probe.parent() {
            Some(parent) if parent != probe => probe = parent.to_path_buf(),
            _ => break,
        }
    }
    if must_exist && std::fs::symlink_metadata(&absolute).is_err() {
        return Err(format!("{label} does not exist: {normalized}"));
    }
    Ok((absolute.clone(), relative_to(&absolute_root, &absolute)))
}

/// Resolves a path argument that may be absolute or root-relative, refusing
/// any target whose real location leaves `root`.
fn resolve_within(
    root: &Path,
    value: Option<&Value>,
    label: &str,
    must_exist: bool,
) -> Result<(PathBuf, String), String> {
    let Some(text) = value.and_then(Value::as_str) else {
        return Err(format!("{label} must be a non-empty path."));
    };
    if text.is_empty() {
        return Err(format!("{label} must be a non-empty path."));
    }
    let normalized = text.replace('\\', "/");
    if normalized.split('/').any(|part| part == "..") {
        return Err(format!("{label} must not contain \"..\": {normalized}"));
    }
    let absolute_root = resolve_path(root);
    let absolute = resolve_path(&if Path::new(&normalized).is_absolute() {
        PathBuf::from(&normalized)
    } else {
        absolute_root.join(&normalized)
    });
    if !absolute.starts_with(&absolute_root) {
        return Err(format!("{label} leaves its root: {normalized}"));
    }
    let Some(root_real) = std::fs::canonicalize(&absolute_root).ok() else {
        return Err(format!(
            "{label} root does not exist: {}",
            absolute_root.to_string_lossy()
        ));
    };
    let mut probe = absolute.clone();
    loop {
        if let Ok(real) = std::fs::canonicalize(&probe) {
            if !real.starts_with(&root_real) {
                return Err(format!("{label} resolves outside its root: {normalized}"));
            }
            break;
        }
        match probe.parent() {
            Some(parent) if parent != probe => probe = parent.to_path_buf(),
            _ => break,
        }
    }
    if must_exist && std::fs::symlink_metadata(&absolute).is_err() {
        return Err(format!("{label} does not exist: {normalized}"));
    }
    Ok((absolute.clone(), relative_to(&absolute_root, &absolute)))
}

fn relative_to(root: &Path, target: &Path) -> String {
    let root_components: Vec<std::path::Component> = root.components().collect();
    let target_components: Vec<std::path::Component> = target.components().collect();
    let mut shared = 0;
    while shared < root_components.len()
        && shared < target_components.len()
        && root_components[shared] == target_components[shared]
    {
        shared += 1;
    }
    let mut parts: Vec<String> = Vec::new();
    for _ in shared..root_components.len() {
        parts.push("..".to_string());
    }
    for component in &target_components[shared..] {
        parts.push(component.as_os_str().to_string_lossy().into_owned());
    }
    parts.join("/")
}

fn pretty_write(path: &Path, value: &Value) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut text = serde_json::to_string_pretty(value).unwrap_or_default();
    text.push('\n');
    std::fs::write(path, text)
}

fn append_line(path: &Path, value: &Value) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    file.write_all(format!("{}\n", crate::jsjson::stringify(value)).as_bytes())
}

fn byte_len(text: &str) -> usize {
    text.len()
}

fn take_chars(text: &str, count: usize) -> String {
    text.chars().take(count).collect()
}

// ---------------------------------------------------------------------------
// Tool logging
// ---------------------------------------------------------------------------

fn inside_root(root: &Path, candidate: &Path) -> bool {
    let Some(real_root) = std::fs::canonicalize(root).ok() else {
        return false;
    };
    candidate.starts_with(&real_root)
}

fn tool_log_path(context: &McpContext, key: &str) -> Option<PathBuf> {
    let configured = environment_value(context, key).filter(|value| !value.is_empty())?;
    let absolute = resolve_path(&if Path::new(configured).is_absolute() {
        PathBuf::from(configured)
    } else {
        context.repo_dir.join(configured)
    });
    let parent = absolute.parent().unwrap_or(&absolute);
    let target = match std::fs::canonicalize(parent) {
        Ok(real_parent) => real_parent.join(
            absolute
                .file_name()
                .map(|name| name.to_os_string())
                .unwrap_or_default(),
        ),
        Err(_) => absolute,
    };
    if inside_root(&context.repo_dir, &target) || inside_root(&context.state_dir, &target) {
        Some(target)
    } else {
        None
    }
}

fn append_tool_log(context: &McpContext, entry: Value, key: &str) {
    let Some(path) = tool_log_path(context, key) else {
        return;
    };
    let _ = append_line(&path, &entry);
}

fn log_tool_call(context: &McpContext, tool: &str, result: &Value) {
    let mut entry = Map::new();
    entry.insert("tool".into(), json!(tool));
    entry.insert("at".into(), json!(now_iso()));
    let error = result.get("error").cloned();
    entry.insert("ok".into(), json!(error.is_none()));
    if let Some(value) = result.get("value") {
        entry.insert("value".into(), value.clone());
    }
    if let Some(error) = error {
        entry.insert("error".into(), error);
    }
    append_tool_log(context, Value::Object(entry), "DEVBOARD_TOOL_LOG");
}

// ---------------------------------------------------------------------------
// Tool dispatcher
// ---------------------------------------------------------------------------

pub async fn call_tool(context: &McpContext, name: Option<&Value>, args: Option<&Value>) -> Value {
    let name = match name {
        Some(Value::String(name)) => name.clone(),
        other => {
            return json!({"error": format!("Unknown tool: {}", other.map(js_string).unwrap_or_else(|| "undefined".to_string()))});
        }
    };
    let Some(definition) = tool_definition(&name) else {
        return json!({"error": format!("Unknown tool: {name}")});
    };
    if let Some(value) = args {
        if !value.is_object() {
            return json!({"error": "Tool arguments must be an object."});
        }
    }
    let empty = Map::new();
    let arguments = args.and_then(Value::as_object).unwrap_or(&empty);
    let schema = definition
        .get("inputSchema")
        .cloned()
        .unwrap_or(Value::Null);
    if let Some(invalid) =
        validate_arguments(&schema, &Value::Object(arguments.clone()), "arguments")
    {
        let result = json!({"error": invalid});
        if mutating_tool(&name) {
            log_tool_call(context, &name, &result);
        }
        return result;
    }
    match dispatch(context, &name, arguments).await {
        Ok(value) => {
            let result = json!({"value": value});
            if mutating_tool(&name) {
                log_tool_call(context, &name, &result);
            }
            result
        }
        Err(error) => {
            let result = json!({"error": error});
            if mutating_tool(&name) {
                log_tool_call(context, &name, &result);
            }
            result
        }
    }
}

async fn dispatch(
    context: &McpContext,
    name: &str,
    args: &Map<String, Value>,
) -> Result<Value, String> {
    match name {
        "agent_sessions_list" => agent_sessions_list(context, args),
        "agent_session_read" => {
            let id = string_argument(args, "id")?;
            agent_sessions::read_session_messages(
                &context.state_dir,
                &context.repo_dir,
                &id,
                number_argument(args, "offset").map(|value| value.max(0.0) as usize),
                number_argument(args, "limit").map(|value| value.max(0.0) as usize),
            )
            .ok_or_else(|| format!("No session {id} in this repository's evidence."))
        }
        "agent_session_search" => Ok(agent_sessions::search_sessions(
            &context.state_dir,
            &context.repo_dir,
            &string_argument(args, "query")?,
            number_argument(args, "limit").map(|value| value.max(0.0) as usize),
            None,
        )),
        "background_agent_control" => background_agent_control(context, args).await,
        "background_agent_get" => {
            let id = string_argument(args, "id")?;
            background_agent_get(context, &id).await
        }
        "background_agents_list" => Ok(json!({"agents": background_agents_list(context).await?})),
        "devboard_status" => devboard_status(context).await,
        "design_release_request" => design_release_request(context, args),
        "discover_contribution_stage" => stage_discover_contribution(context, args),
        "discover_glossary_stage" => stage_discover_glossary(context, args),
        "discover_sheet_stage" => stage_discover_sheet(context, args),
        "discover_significance_stage" => stage_discover_significance(context, args),
        "discover_skill_stage" => stage_discover_skill(context, args),
        "entry_point" => pick_entry_point(context, args),
        "flow_checkpoint_record" => record_flow_checkpoint(context, args),
        "flow_control" => flow_control(context, args).await,
        "flow_steering_ack" => acknowledge_flow_steering(context, args),
        "flow_verification_record" => record_flow_verification(context, args),
        "flow_widgets_register" => register_flow_widgets(context, args),
        "goal_control" => goal_control(context, args).await,
        "goal_draft_file" => file_goal_draft(context, args).await,
        "goal_draft_read" => goal_draft_read(context, args),
        "goal_drafts_list" => Ok(json!({
            "drafts": crate::goal_drafts::list_goal_drafts(&context.repo_dir)
                .into_iter()
                .map(|draft| draft.to_json())
                .collect::<Vec<_>>()
        })),
        "goal_get" => Ok(goal_text(context)),
        "goal_spec_write" => write_goal_spec(context, args),
        "issue_close" => close_issue(context, args).await,
        "issue_comment" => comment_issue(context, args).await,
        "issue_create" => create_issue(context, args).await,
        "issue_get" => get_issue(context, args).await,
        "issues_control" => issues_control(context, args).await,
        "issues_list" => list_issues(context, args).await,
        "journal_search" => search_journal(context, args),
        "lifecycle_control" => lifecycle_control(context, args).await,
        "mcp_optimizer_proposal_skip" => record_mcp_optimizer_skip(context, args),
        "verification_run" => run_verification(context, args).await,
        "watchdog_duplicate_record" => record_watchdog_duplicate(context, args),
        other => Err(format!("Unknown tool: {other}")),
    }
}

fn agent_sessions_list(context: &McpContext, args: &Map<String, Value>) -> Result<Value, String> {
    let limit = match args.get("limit").and_then(Value::as_f64) {
        Some(value) if value.is_finite() => Some(value.max(0.0) as usize),
        _ => None,
    };
    let offset = match args.get("offset").and_then(Value::as_f64) {
        Some(value) if value.is_finite() => Some(value.max(0.0) as usize),
        _ => None,
    };
    Ok(agent_sessions::list_sessions(&ListSessionsOptions {
        state_dir: context.state_dir.clone(),
        repo_dir: context.repo_dir.clone(),
        since: optional_string(args, "since")?,
        until: optional_string(args, "until")?,
        cwd: optional_string(args, "cwd")?,
        limit,
        offset,
        max_files: None,
        mtime_since: None,
    }))
}

// ---------------------------------------------------------------------------
// Goals and drafts
// ---------------------------------------------------------------------------

fn goal_text(context: &McpContext) -> Value {
    let path = environment_value(context, "GOAL_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| context.repo_dir.join("GOAL.md"));
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let bounded = bound_bytes(&text, GOAL_TEXT_MAX_BYTES, "...");
    json!({"goal": bounded.text, "truncated": bounded.truncated})
}

fn goal_draft_read(context: &McpContext, args: &Map<String, Value>) -> Result<Value, String> {
    let draft = crate::goal_drafts::read_goal_draft(&context.repo_dir, args.get("path"))
        .map_err(|error| error.message)?;
    let bounded = bound_bytes(&draft.text, GOAL_TEXT_MAX_BYTES, "...");
    Ok(json!({
        "path": draft.path,
        "name": draft.name,
        "heading": draft.heading,
        "text": bounded.text,
        "truncated": bounded.truncated,
    }))
}

/// Lowercase kebab-case over `[a-z0-9-]`, at most six words.
fn derive_slug(text: &str) -> String {
    let lowered: String = text.to_lowercase();
    let mut words: Vec<String> = Vec::new();
    let mut current = String::new();
    for character in lowered.chars() {
        if character.is_ascii_lowercase() || character.is_ascii_digit() {
            current.push(character);
        } else if !current.is_empty() {
            words.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        words.push(current);
    }
    let words: Vec<String> = words.into_iter().take(6).collect();
    if words.is_empty() {
        "goal".to_string()
    } else {
        words.join("-")
    }
}

fn free_slug(goals_dir: &Path, base: &str) -> String {
    let mut attempt = 1u32;
    loop {
        let slug = if attempt == 1 {
            base.to_string()
        } else {
            format!("{base}-{attempt}")
        };
        if !goals_dir.join(format!("{slug}.md")).exists() {
            return slug;
        }
        attempt += 1;
    }
}

fn valid_slug(slug: &str) -> bool {
    if slug.is_empty() || slug.starts_with('-') || slug.ends_with('-') {
        return false;
    }
    slug.split('-').all(|part| {
        !part.is_empty()
            && part
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    })
}

fn write_goal_spec(context: &McpContext, args: &Map<String, Value>) -> Result<Value, String> {
    let keys = [
        "objective",
        "successCriteria",
        "verification",
        "boundaries",
        "stopConditions",
    ];
    let mut bodies: Vec<String> = Vec::new();
    for (index, key) in keys.iter().enumerate() {
        match args.get(*key).and_then(Value::as_str) {
            Some(body) if !body.trim().is_empty() => bodies.push(body.to_string()),
            _ => {
                return Err(format!(
                    "The {} section must not be empty.",
                    GOAL_SECTION_HEADINGS[index]
                ))
            }
        }
    }
    let (goals_dir, _) = resolve_contained(
        &context.repo_dir,
        Some(&json!(".devboard/goals")),
        "goal spec directory",
        false,
    )?;
    let objective = &bodies[0];
    let requested = match args.get("slug").and_then(Value::as_str) {
        Some(slug) if !slug.trim().is_empty() => slug.trim().to_string(),
        _ => {
            let first_line = objective
                .split('\n')
                .find(|line| !line.trim().is_empty())
                .unwrap_or(objective);
            derive_slug(first_line)
        }
    };
    if !valid_slug(&requested) {
        return Err("A slug must be lowercase kebab-case over [a-z0-9-].".to_string());
    }
    std::fs::create_dir_all(&goals_dir)
        .map_err(|_| "The goal spec directory could not be created.".to_string())?;
    let slug = free_slug(&goals_dir, &requested);
    let sections: Vec<String> = GOAL_SECTION_HEADINGS
        .iter()
        .enumerate()
        .map(|(index, heading)| format!("## {heading}\n\n{}", bodies[index].trim_end()))
        .collect();
    let content = format!("{}\n", sections.join("\n\n"));
    let path = goals_dir.join(format!("{slug}.md"));
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    file.write_all(content.as_bytes())
        .map_err(|error| error.to_string())?;
    Ok(json!({"path": format!(".devboard/goals/{slug}.md"), "slug": slug}))
}

fn valid_goal_title(value: Option<&Value>) -> Result<String, String> {
    let Some(value) = value.and_then(Value::as_str) else {
        return Err("A one-line title is required.".to_string());
    };
    if value.trim().is_empty() {
        return Err("A one-line title is required.".to_string());
    }
    let title = value.trim().to_string();
    if title.contains('\n') || title.contains('\r') {
        return Err("The title must be one line.".to_string());
    }
    if crate::feedback::js_len(&title) > GOAL_TITLE_MAX {
        return Err(format!(
            "The title must be at most {GOAL_TITLE_MAX} characters."
        ));
    }
    if title.trim_start().starts_with('#') {
        return Err("The title must not begin with a heading marker.".to_string());
    }
    Ok(title)
}

fn issues_client(context: &McpContext) -> Result<ForgeIssuesClient, String> {
    let mut options = ForgeIssuesOptions::new(context.repo_dir.clone());
    options.environment = context.environment.clone();
    ForgeIssuesClient::new(options).map_err(|error| error.message)
}

async fn file_goal_draft(context: &McpContext, args: &Map<String, Value>) -> Result<Value, String> {
    let mut step = "validate".to_string();
    let outcome: Result<Value, String> = async {
        let title = valid_goal_title(args.get("title"))?;
        let (spec_absolute, spec_relative) =
            resolve_contained(&context.repo_dir, args.get("specPath"), "specPath", true)?;
        if !spec_relative.starts_with(".devboard/goals/") {
            return Err("specPath must name a file under .devboard/goals/.".to_string());
        }
        if !spec_relative.ends_with(".md") {
            return Err("specPath must end in .md.".to_string());
        }
        let draft_file = match args.get("draftPath") {
            Some(value) if !value.is_null() => {
                let (_, _, file) =
                    crate::goal_drafts::resolve_goal_draft(&context.repo_dir, Some(value))
                        .map_err(|error| error.message)?;
                Some(file)
            }
            _ => None,
        };
        let body = std::fs::read_to_string(&spec_absolute)
            .map_err(|_| format!("No file at {spec_relative}."))?;
        let forge = issues_client(context)?;
        step = "ensure the goal label".to_string();
        forge
            .ensure_label("goal")
            .await
            .map_err(|error| error.message)?;
        step = "create the issue".to_string();
        let created = forge
            .create(&CreateForgeIssueInput {
                title,
                body: body.clone(),
                labels: vec!["goal".to_string()],
            })
            .await
            .map_err(|error| error.message)?;
        step = "read the issue back".to_string();
        let stored = forge
            .get(created.number)
            .await
            .map_err(|error| error.message)?;
        step = "verify the label".to_string();
        if !stored.labels.iter().any(|label| label == "goal") {
            return Ok(json!({
                "ok": false,
                "step": step,
                "message": format!("issue #{} does not carry the goal label", created.number),
                "number": created.number,
                "url": created.url,
            }));
        }
        step = "verify the body".to_string();
        if stored.body != body {
            return Ok(json!({
                "ok": false,
                "step": step,
                "message": format!("issue #{} body differs from {}", created.number, spec_relative),
                "number": created.number,
                "url": created.url,
            }));
        }
        if let Some(file) = draft_file.as_ref() {
            step = "remove the draft".to_string();
            std::fs::remove_file(file).map_err(|error| error.to_string())?;
        }
        Ok(json!({
            "ok": true,
            "number": created.number,
            "url": created.url,
            "draftRemoved": draft_file.is_some(),
        }))
    }
    .await;
    match outcome {
        Ok(result) => {
            if result.get("ok").and_then(Value::as_bool) == Some(true) {
                Ok(result)
            } else {
                let message = result
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let failed_step = result
                    .get("step")
                    .and_then(Value::as_str)
                    .unwrap_or(step.as_str());
                Err(format!(
                    "goal_draft_file failed at \"{failed_step}\": {message}"
                ))
            }
        }
        Err(message) => Err(format!("goal_draft_file failed at \"{step}\": {message}")),
    }
}

// ---------------------------------------------------------------------------
// Journal search
// ---------------------------------------------------------------------------

fn search_journal(context: &McpContext, args: &Map<String, Value>) -> Result<Value, String> {
    let instant = |name: &str| -> Result<Option<i64>, String> {
        match args.get(name).and_then(Value::as_str) {
            Some(value) => agent_sessions::parse_instant_text(value)
                .map(Some)
                .ok_or_else(|| format!("{name} must be an ISO 8601 timestamp.")),
            None => Ok(None),
        }
    };
    let since = instant("since")?;
    let until = instant("until")?;
    if let Some(kind) = args.get("kind").and_then(Value::as_str) {
        if !crate::journal::JOURNAL_KINDS.contains(&kind) {
            return Err(format!(
                "kind must be one of: {}",
                crate::journal::JOURNAL_KINDS.join(", ")
            ));
        }
    }
    let scope = args
        .get("scope")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_lowercase());
    let limit = match args.get("limit").and_then(Value::as_f64) {
        Some(value) if value.is_finite() && value.fract() == 0.0 => {
            (value as i64).clamp(1, JOURNAL_SEARCH_MAX_RECORDS as i64) as usize
        }
        _ => JOURNAL_SEARCH_MAX_RECORDS,
    };
    let end = until.unwrap_or_else(now_millis);
    let start = since.unwrap_or(0);
    let journal = crate::journal::journal_file(&context.state_dir, &context.repo_dir);
    let instance = crate::workers::watchdog::Instance {
        pid: 0,
        port: 0,
        repo_dir: context.repo_dir.to_string_lossy().into_owned(),
        host: "127.0.0.1".to_string(),
        harness: context.harness_dir.to_string_lossy().into_owned(),
        state_dir: context.state_dir.to_string_lossy().into_owned(),
        journal: journal.to_string_lossy().into_owned(),
        instrumented: true,
        legacy_log: None,
    };
    let window = crate::workers::watchdog::Window {
        start_ms: start,
        end_ms: end,
    };
    let (events, _) =
        crate::workers::watchdog::read_journal_evidence(&instance, window, &context.repo_dir);
    let kind = args.get("kind").and_then(Value::as_str);
    let mut rows: Vec<(String, String, String, Option<String>)> = Vec::new();
    for event in events {
        if let Some(kind) = kind {
            if event.kind != kind {
                continue;
            }
        }
        if let Some(scope) = scope.as_ref() {
            if event.scope.as_deref() != Some(scope.as_str()) {
                continue;
            }
        }
        if let Some(query) = query.as_ref() {
            if !event.text.to_lowercase().contains(query.as_str()) {
                continue;
            }
        }
        rows.push((event.ts, event.kind, event.text, event.scope));
    }
    rows.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| left.1.cmp(&right.1))
            .then_with(|| {
                left.3
                    .clone()
                    .unwrap_or_default()
                    .cmp(&right.3.clone().unwrap_or_default())
            })
            .then_with(|| left.2.cmp(&right.2))
    });
    let total = rows.len();
    let mut records: Vec<Value> = Vec::new();
    let mut bytes = 0usize;
    for (ts, kind, text, scope) in rows {
        if records.len() >= limit {
            break;
        }
        let row = json!({"ts": ts, "kind": kind, "text": text, "scope": scope});
        let cost = byte_len(&crate::jsjson::stringify(&row));
        if !records.is_empty() && bytes + cost > JOURNAL_SEARCH_MAX_BYTES {
            break;
        }
        bytes += cost;
        records.push(row);
    }
    let truncated = records.len() < total;
    Ok(json!({"records": records, "total": total, "truncated": truncated}))
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

fn git_state(repo_dir: &Path) -> Value {
    let empty = || json!({"branch": null, "upstream": null, "ahead": 0, "behind": 0});
    let output = match Command::new("git")
        .arg("-C")
        .arg(repo_dir)
        .args(["status", "--porcelain=v2", "--branch"])
        .output()
    {
        Ok(output) if output.status.success() => output,
        _ => return empty(),
    };
    let mut branch: Option<String> = None;
    let mut upstream: Option<String> = None;
    let mut ahead = 0;
    let mut behind = 0;
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.split('\n') {
        if let Some(head) = line.strip_prefix("# branch.head ") {
            let head = head.trim();
            branch = if head.is_empty() || head == "(detached)" {
                None
            } else {
                Some(head.to_string())
            };
        } else if let Some(value) = line.strip_prefix("# branch.upstream ") {
            let value = value.trim();
            upstream = if value.is_empty() {
                None
            } else {
                Some(value.to_string())
            };
        } else if let Some(value) = line.strip_prefix("# branch.ab ") {
            let value = value.trim();
            let mut parts = value.split(' ');
            if let (Some(counts), Some(missing)) = (parts.next(), parts.next()) {
                if let (Some(added), Some(removed)) = (
                    counts
                        .strip_prefix('+')
                        .and_then(|value| value.parse::<i64>().ok()),
                    missing
                        .strip_prefix('-')
                        .and_then(|value| value.parse::<i64>().ok()),
                ) {
                    ahead = added;
                    behind = removed;
                }
            }
        }
    }
    json!({"branch": branch, "upstream": upstream, "ahead": ahead, "behind": behind})
}

async fn live_version(dashboard: &LiveDashboard) -> Option<Value> {
    let reply = dashboard_command(
        dashboard,
        json!({"type": "getVersion"}),
        |reply| reply.get("type").and_then(Value::as_str) == Some("versionState"),
        5_000,
    )
    .await
    .ok()?;
    Some(json!({
        "running": reply.get("running").cloned().filter(|value| value.is_string()).unwrap_or(Value::Null),
        "installed": reply.get("installed").cloned().filter(|value| value.is_string()).unwrap_or(Value::Null),
        "latest": reply.get("latest").cloned().filter(|value| value.is_string()).unwrap_or(Value::Null),
        "stale": reply.get("stale").and_then(Value::as_bool) == Some(true),
        "source": reply.get("source").and_then(Value::as_bool) == Some(true),
    }))
}

async fn devboard_status(context: &McpContext) -> Result<Value, String> {
    let dashboards = dashboards_for(context);
    let dashboard = if dashboards.len() == 1 {
        dashboards.first().cloned()
    } else {
        None
    };
    let live = match dashboard.as_ref() {
        Some(dashboard) => live_version(dashboard).await,
        None => None,
    };
    let fallback = crate::version::server_version(
        &context.repo_dir,
        crate::version::read_harness_version(&context.harness_dir),
        None,
    );
    let version = live.unwrap_or_else(|| {
        json!({
            "running": fallback.running,
            "installed": fallback.installed,
            "latest": fallback.latest,
            "stale": fallback.stale,
            "source": fallback.source,
        })
    });
    let installed = version.get("installed").cloned().unwrap_or(Value::Null);
    let running = version.get("running").cloned().unwrap_or(Value::Null);
    let version_state = if version.get("stale").and_then(Value::as_bool) == Some(true) {
        "stale"
    } else if !installed.is_null() && running == installed {
        "latest"
    } else if !installed.is_null() {
        "installed"
    } else {
        "running"
    };
    let dashboard_json = match dashboard.as_ref() {
        Some(dashboard) => json!({"port": dashboard.port, "pid": dashboard.pid}),
        None => Value::Null,
    };
    Ok(json!({
        "repositoryRoot": context.repo_dir.to_string_lossy(),
        "harnessDirectory": context.harness_dir.to_string_lossy(),
        "stateDirectory": context.state_dir.to_string_lossy(),
        "git": git_state(&context.repo_dir),
        "dashboard": dashboard_json,
        "version": {
            "running": version.get("running").cloned().unwrap_or(Value::Null),
            "installed": version.get("installed").cloned().unwrap_or(Value::Null),
            "latest": version.get("latest").cloned().unwrap_or(Value::Null),
            "source": version.get("source").and_then(Value::as_bool) == Some(true),
        },
        "versionState": version_state,
    }))
}

// ---------------------------------------------------------------------------
// Flow session writes
// ---------------------------------------------------------------------------

fn non_empty(value: Option<&Value>, field: &str) -> Result<String, String> {
    match value.and_then(Value::as_str) {
        Some(text) if !text.trim().is_empty() => Ok(text.trim().to_string()),
        _ => Err(format!("{field} must be a non-empty string.")),
    }
}

fn optional_text(value: Option<&Value>, field: &str) -> Result<String, String> {
    match value {
        None => Ok(String::new()),
        Some(Value::String(text)) => Ok(text.clone()),
        Some(_) => Err(format!("{field} must be a string.")),
    }
}

fn flow_session_directory(context: &McpContext, value: Option<&Value>) -> Result<PathBuf, String> {
    let root = context.state_dir.join("flow");
    std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let (directory, _) = resolve_within(&root, value, "sessionDir", true)?;
    Ok(directory)
}

fn flow_widgets(value: Option<&Value>) -> Result<Vec<Value>, String> {
    let Some(entries) = value.and_then(Value::as_array) else {
        return Err("widgets must be a list.".to_string());
    };
    let mut widgets: Vec<Value> = Vec::new();
    let categories: HashSet<&str> = FLOW_CATEGORIES.iter().copied().collect();
    for (index, entry) in entries.iter().enumerate() {
        let number = index + 1;
        let Some(record) = entry.as_object() else {
            return Err(format!("widget {number} must be an object."));
        };
        let category = non_empty(record.get("category"), &format!("widget {number} category"))?;
        if !categories.contains(category.as_str()) {
            return Err(format!(
                "widget {number} category must be one of {}.",
                FLOW_CATEGORIES.join(", ")
            ));
        }
        let Some(files) = record.get("files").and_then(Value::as_array) else {
            return Err(format!("widget {number} files must be a non-empty list."));
        };
        if files.is_empty() {
            return Err(format!("widget {number} files must be a non-empty list."));
        }
        let mut seen: HashSet<String> = HashSet::new();
        let mut names: Vec<Value> = Vec::new();
        for file in files {
            let name = non_empty(Some(file), &format!("widget {number} file"))?.replace('\\', "/");
            if seen.insert(name.clone()) {
                names.push(Value::String(name));
            }
        }
        widgets.push(json!({
            "category": category,
            "concept": non_empty(record.get("concept"), &format!("widget {number} concept"))?,
            "summary": non_empty(record.get("summary"), &format!("widget {number} summary"))?,
            "rationale": non_empty(record.get("rationale"), &format!("widget {number} rationale"))?,
            "files": names,
        }));
    }
    Ok(widgets)
}

fn register_flow_widgets(context: &McpContext, args: &Map<String, Value>) -> Result<Value, String> {
    let directory = flow_session_directory(context, args.get("sessionDir"))?;
    let widgets = flow_widgets(args.get("widgets"))?;
    let path = directory.join("widgets.json");
    pretty_write(&path, &json!({"widgets": widgets})).map_err(|error| error.to_string())?;
    Ok(json!({"path": path.to_string_lossy(), "widgets": widgets.len()}))
}

fn read_acknowledged(path: &Path) -> HashSet<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let Ok(text) = std::fs::read_to_string(path) else {
        return seen;
    };
    for line in text.split('\n') {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        match parsed {
            Value::String(id) => {
                seen.insert(id);
            }
            Value::Object(record) => {
                if let Some(id) = record.get("id").and_then(Value::as_str) {
                    seen.insert(id.to_string());
                }
            }
            _ => {}
        }
    }
    seen
}

fn acknowledge_flow_steering(
    context: &McpContext,
    args: &Map<String, Value>,
) -> Result<Value, String> {
    let directory = flow_session_directory(context, args.get("sessionDir"))?;
    let Some(ids) = args.get("ids").and_then(Value::as_array) else {
        return Err("ids must be a list of steering ids.".to_string());
    };
    let path = directory.join("steering-ack.jsonl");
    let mut seen = read_acknowledged(&path);
    let mut acknowledged: Vec<Value> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();
    for entry in ids {
        let id = non_empty(Some(entry), "steering id")?;
        if seen.contains(&id) {
            skipped.push(Value::String(id));
            continue;
        }
        seen.insert(id.clone());
        append_line(&path, &json!({"id": id})).map_err(|error| error.to_string())?;
        acknowledged.push(Value::String(id));
    }
    Ok(json!({
        "path": path.to_string_lossy(),
        "acknowledged": acknowledged,
        "skipped": skipped,
    }))
}

fn record_flow_checkpoint(
    context: &McpContext,
    args: &Map<String, Value>,
) -> Result<Value, String> {
    let directory = flow_session_directory(context, args.get("sessionDir"))?;
    let commit = non_empty(args.get("commit"), "commit")?;
    let short = take_chars(&commit, 7);
    let id = match args.get("id") {
        None => format!("checkpoint-{short}"),
        Some(value) => non_empty(Some(value), "id")?,
    };
    let summary = non_empty(args.get("summary"), "summary")?;
    let files = match args.get("files") {
        None => 0f64,
        Some(value) => match value.as_f64() {
            Some(number) if number.is_finite() && number.fract() == 0.0 && number >= 0.0 => number,
            _ => return Err("files must be a non-negative integer.".to_string()),
        },
    };
    let verification = match args.get("verification") {
        None => "not-run".to_string(),
        Some(Value::String(value))
            if value == "passed" || value == "failed" || value == "not-run" =>
        {
            value.clone()
        }
        Some(_) => {
            return Err("verification must be \"passed\", \"failed\", or \"not-run\".".to_string())
        }
    };
    let timestamp = match args.get("timestamp") {
        None => now_iso(),
        Some(value) => non_empty(Some(value), "timestamp")?,
    };
    let path = directory.join("checkpoints.jsonl");
    append_line(
        &path,
        &json!({
            "id": id,
            "timestamp": timestamp,
            "summary": summary,
            "files": files,
            "commit": commit,
            "verification": verification,
        }),
    )
    .map_err(|error| error.to_string())?;
    Ok(json!({"path": path.to_string_lossy(), "id": id, "commit": commit, "summary": summary}))
}

fn record_flow_verification(
    context: &McpContext,
    args: &Map<String, Value>,
) -> Result<Value, String> {
    let directory = flow_session_directory(context, args.get("sessionDir"))?;
    let status = match args.get("status").and_then(Value::as_str) {
        Some(value) if value == "passed" || value == "failed" || value == "not-run" => {
            value.to_string()
        }
        _ => return Err("status must be \"passed\", \"failed\", or \"not-run\".".to_string()),
    };
    let command = optional_text(args.get("command"), "command")?;
    let output = optional_text(args.get("output"), "output")?;
    let timestamp = match args.get("timestamp") {
        None => now_iso(),
        Some(value) => non_empty(Some(value), "timestamp")?,
    };
    let path = directory.join("verification.json");
    pretty_write(
        &path,
        &json!({
            "command": command,
            "status": status,
            "timestamp": timestamp,
            "output": output,
        }),
    )
    .map_err(|error| error.to_string())?;
    Ok(json!({"path": path.to_string_lossy(), "status": status, "timestamp": timestamp}))
}

// ---------------------------------------------------------------------------
// Discover staging writes
// ---------------------------------------------------------------------------

const KEBAB_ID: &str = r"^[a-z0-9]+(?:-[a-z0-9]+)*$";

fn kebab() -> &'static regex::Regex {
    static VALUE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(KEBAB_ID).expect("a kebab regex"));
    &VALUE
}

fn staging_directory(context: &McpContext, value: Option<&Value>) -> Result<PathBuf, String> {
    let root = context
        .repo_dir
        .join(".omp")
        .join("discover")
        .join("staging");
    std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let (directory, _) = resolve_within(&root, value, "stagingDir", true)?;
    Ok(directory)
}

fn object_argument(value: Option<&Value>, label: &str) -> Result<Map<String, Value>, String> {
    match value.and_then(Value::as_object) {
        Some(record) => Ok(record.clone()),
        None => Err(format!("{label} must be an object.")),
    }
}

fn schema_version_of(record: &Map<String, Value>) -> Value {
    match record.get("schemaVersion").and_then(Value::as_f64) {
        Some(value) if value.fract() == 0.0 => json!(value as i64),
        Some(value) => json!(value),
        None => Value::Null,
    }
}

fn stage_discover_sheet(context: &McpContext, args: &Map<String, Value>) -> Result<Value, String> {
    let directory = staging_directory(context, args.get("stagingDir"))?;
    let sheet = object_argument(args.get("sheet"), "sheet")?;
    let path = directory.join("sheet.json");
    pretty_write(&path, &Value::Object(sheet.clone())).map_err(|error| error.to_string())?;
    Ok(json!({"path": path.to_string_lossy(), "schemaVersion": schema_version_of(&sheet)}))
}

fn stage_discover_contribution(
    context: &McpContext,
    args: &Map<String, Value>,
) -> Result<Value, String> {
    let directory = staging_directory(context, args.get("stagingDir"))?;
    let contribution = object_argument(args.get("contribution"), "contribution")?;
    let path = directory.join("contribution.json");
    pretty_write(&path, &Value::Object(contribution.clone())).map_err(|error| error.to_string())?;
    Ok(json!({"path": path.to_string_lossy(), "schemaVersion": schema_version_of(&contribution)}))
}

fn stage_discover_glossary(
    context: &McpContext,
    args: &Map<String, Value>,
) -> Result<Value, String> {
    let directory = staging_directory(context, args.get("stagingDir"))?;
    let bounded_context = args
        .get("context")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !kebab().is_match(bounded_context) {
        return Err("context must be a kebab-case bounded-context id.".to_string());
    }
    let yaml = args.get("yaml").and_then(Value::as_str).unwrap_or_default();
    if yaml.trim().is_empty() {
        return Err("yaml must be the non-empty glossary document text.".to_string());
    }
    let path = directory
        .join("glossary")
        .join(format!("{bounded_context}.glossary.yaml"));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let text = if yaml.ends_with('\n') {
        yaml.to_string()
    } else {
        format!("{yaml}\n")
    };
    std::fs::write(&path, text).map_err(|error| error.to_string())?;
    Ok(json!({"path": path.to_string_lossy(), "context": bounded_context}))
}

fn stage_discover_significance(
    context: &McpContext,
    args: &Map<String, Value>,
) -> Result<Value, String> {
    let directory = staging_directory(context, args.get("stagingDir"))?;
    let significance = object_argument(args.get("significance"), "significance")?;
    let path = directory.join("glossary").join("significance.json");
    pretty_write(&path, &Value::Object(significance.clone())).map_err(|error| error.to_string())?;
    Ok(json!({"path": path.to_string_lossy(), "schemaVersion": schema_version_of(&significance)}))
}

fn stage_discover_skill(context: &McpContext, args: &Map<String, Value>) -> Result<Value, String> {
    let directory = staging_directory(context, args.get("stagingDir"))?;
    let name = args.get("name").and_then(Value::as_str).unwrap_or_default();
    if !DISCOVER_SKILL_NAMES.contains(&name) {
        return Err(format!(
            "name must be one of {}.",
            DISCOVER_SKILL_NAMES.join(", ")
        ));
    }
    let description = args
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if description.trim().is_empty() {
        return Err("description must be a non-empty one-line sentence.".to_string());
    }
    if description.contains('\r') || description.contains('\n') {
        return Err("description must be one line.".to_string());
    }
    if byte_len(description) > 1024 {
        return Err("description must be at most 1024 bytes.".to_string());
    }
    let body = args.get("body").and_then(Value::as_str).unwrap_or_default();
    if !starts_with_heading(body) {
        return Err("body must start with a level-one heading.".to_string());
    }
    let body = body.trim_end();
    let skill = name.strip_prefix("discover-").unwrap_or(name);
    let quoted = crate::jsjson::stringify(&Value::String(description.trim().to_string()));
    let text = [
        "---",
        &format!("name: {name}"),
        &format!("description: {quoted}"),
        "metadata:",
        "  devboard-managed: \"true\"",
        "  devboard-family: \"discover\"",
        &format!("  devboard-skill: {skill}"),
        "---",
        "",
        body,
        "",
    ]
    .join("\n");
    let path = directory.join("skills").join(name).join("SKILL.md");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(&path, text).map_err(|error| error.to_string())?;
    Ok(json!({"path": path.to_string_lossy(), "name": name}))
}

fn starts_with_heading(body: &str) -> bool {
    static VALUE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"^\s*#\s+\S").expect("a heading regex"));
    VALUE.is_match(body)
}

// ---------------------------------------------------------------------------
// Design release request
// ---------------------------------------------------------------------------

const DESIGN_RELEASE_REQUEST: &str = "release-request.json";
const DESIGN_RELEASE_VERSION: i64 = 1;

fn design_sentence(value: Option<&Value>, field: &str, max: usize) -> Result<String, String> {
    match value.and_then(Value::as_str) {
        Some(text) if !text.trim().is_empty() => {
            let text = text.trim().to_string();
            if byte_len(&text) > max {
                return Err(format!("{field} must be at most {max} bytes."));
            }
            Ok(text)
        }
        _ => Err(format!("{field} must be a non-empty sentence.")),
    }
}

fn design_release_request(
    context: &McpContext,
    args: &Map<String, Value>,
) -> Result<Value, String> {
    let root = context
        .repo_dir
        .join(".devboard")
        .join(".tmp")
        .join("design")
        .join("cycles");
    std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let (directory, _) = resolve_within(&root, args.get("cycleDir"), "cycleDir", true)?;
    let summary = design_sentence(args.get("summary"), "summary", 200)?;
    let rationale = design_sentence(args.get("rationale"), "rationale", 4000)?;
    let path = directory.join(DESIGN_RELEASE_REQUEST);
    pretty_write(
        &path,
        &json!({
            "version": DESIGN_RELEASE_VERSION,
            "summary": summary,
            "rationale": rationale,
            "requestedAt": now_iso(),
        }),
    )
    .map_err(|error| error.to_string())?;
    Ok(json!({"path": path.to_string_lossy(), "summary": summary}))
}

// ---------------------------------------------------------------------------
// Watchdog deduplication and MCP optimizer skip records
// ---------------------------------------------------------------------------

const DEDUP_RECORD_FILE: &str = "dedup-records.jsonl";
const DEDUP_READ_FILE: &str = "dedup-reads.jsonl";

fn dedup_run_directory(context: &McpContext) -> Option<PathBuf> {
    let configured =
        environment_value(context, "DEVBOARD_DEDUP_RUN_DIR").filter(|value| !value.is_empty())?;
    let absolute = resolve_path(&if Path::new(configured).is_absolute() {
        PathBuf::from(configured)
    } else {
        context.repo_dir.join(configured)
    });
    let root = std::fs::canonicalize(&context.state_dir).ok()?;
    let target = match absolute.parent() {
        Some(parent) => match std::fs::canonicalize(parent) {
            Ok(real_parent) => real_parent.join(
                absolute
                    .file_name()
                    .map(|name| name.to_os_string())
                    .unwrap_or_default(),
            ),
            Err(_) => absolute,
        },
        None => absolute,
    };
    target.starts_with(&root).then_some(target)
}

/// Records one candidate this turn filed. `issue_create` is a deduplication
/// run's only filing path, so this record is what attributes the created
/// issue to its candidate; an unrecorded filing reads as no decision and the
/// cycle files the candidate again.
fn record_watchdog_filed(
    directory: &Path,
    fingerprint: &str,
    issue: &ForgeIssueDocument,
) -> Result<(), String> {
    std::fs::create_dir_all(directory)
        .map_err(|error| format!("the dedup run directory: {error}"))?;
    append_line(
        &directory.join(DEDUP_RECORD_FILE),
        &json!({
            "fingerprint": fingerprint,
            "action": "filed",
            "number": issue.number,
            "url": issue.url,
            "title": issue.title,
            "at": now_iso(),
        }),
    )
    .map_err(|error| {
        format!(
            "the issue was created at {} but its dedup record failed: {error}",
            issue.url
        )
    })
}

fn record_watchdog_duplicate(
    context: &McpContext,
    args: &Map<String, Value>,
) -> Result<Value, String> {
    let fingerprint = match args.get("fingerprint").and_then(Value::as_str) {
        Some(value) if !value.trim().is_empty() => value.trim().to_string(),
        _ => return Err("fingerprint must be a non-empty candidate fingerprint.".to_string()),
    };
    let issue = args.get("issue");
    let representative = args.get("representative");
    if issue.is_some() == representative.is_some() {
        return Err(
            "A duplicate names exactly one issue or one representative fingerprint.".to_string(),
        );
    }
    if let Some(issue) = issue {
        match issue.as_str() {
            Some(value) if !value.trim().is_empty() => {}
            _ => return Err("issue must be an open issue URL.".to_string()),
        }
    }
    if let Some(representative) = representative {
        match representative.as_str() {
            Some(value) if !value.trim().is_empty() => {}
            _ => return Err("representative must be a candidate fingerprint.".to_string()),
        }
    }
    let Some(directory) = dedup_run_directory(context) else {
        return Err(
            "DEVBOARD_DEDUP_RUN_DIR does not name a directory in the state root.".to_string(),
        );
    };
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let path = directory.join(DEDUP_RECORD_FILE);
    let mut record = Map::new();
    record.insert("fingerprint".into(), json!(fingerprint.clone()));
    record.insert("action".into(), json!("duplicate"));
    if let Some(issue) = issue.and_then(Value::as_str) {
        record.insert("issue".into(), json!(issue.trim()));
    }
    if let Some(representative) = representative.and_then(Value::as_str) {
        record.insert("representative".into(), json!(representative.trim()));
    }
    record.insert("at".into(), json!(now_iso()));
    append_line(&path, &Value::Object(record)).map_err(|error| error.to_string())?;
    let mut result = Map::new();
    result.insert("fingerprint".into(), json!(fingerprint));
    result.insert("decision".into(), json!("duplicate"));
    if let Some(issue) = issue {
        result.insert("issue".into(), issue.clone());
    }
    if let Some(representative) = representative {
        result.insert("representative".into(), representative.clone());
    }
    Ok(Value::Object(result))
}

fn record_mcp_optimizer_skip(
    context: &McpContext,
    args: &Map<String, Value>,
) -> Result<Value, String> {
    let family = match args.get("family").and_then(Value::as_str) {
        Some(value) if !value.trim().is_empty() => value.trim().to_string(),
        _ => return Err("family must be a non-empty family key.".to_string()),
    };
    let reason = match args.get("reason").and_then(Value::as_str) {
        Some(value) if !value.trim().is_empty() => value.trim().to_string(),
        _ => return Err("reason must state why this family filed nothing.".to_string()),
    };
    let value = json!({"family": family, "status": "skipped", "reason": reason});
    append_tool_log(
        context,
        json!({
            "tool": "mcp_optimizer_proposal_skip",
            "at": now_iso(),
            "ok": true,
            "value": value.clone(),
        }),
        "DEVBOARD_MCP_OPTIMIZER_SKIP_LOG",
    );
    Ok(value)
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

fn issue_state(state: Option<&Value>) -> Result<&'static str, String> {
    match state.and_then(Value::as_str) {
        None | Some("all") => Ok("all"),
        Some("open") => Ok("open"),
        Some("closed") => Ok("closed"),
        Some(_) => Err("state must be \"open\", \"closed\", or \"all\".".to_string()),
    }
}

fn query_state(state: &str) -> IssueQueryState {
    match state {
        "open" => IssueQueryState::Open,
        "closed" => IssueQueryState::Closed,
        _ => IssueQueryState::All,
    }
}

fn issue_row(issue: &crate::forge::ForgeIssueSummary) -> Value {
    json!({
        "number": issue.number,
        "title": issue.title,
        "state": issue.state.as_str(),
        "labels": issue.labels,
        "url": issue.url,
        "createdAt": issue.created_at,
    })
}

fn issue_document(issue: &ForgeIssueDocument, body: &str, truncated: bool) -> Value {
    json!({
        "number": issue.number,
        "title": issue.title.clone(),
        "body": body,
        "state": issue.state.as_str(),
        "labels": issue.labels.clone(),
        "url": issue.url.clone(),
        "createdAt": issue.created_at.clone(),
        "truncated": truncated,
    })
}

async fn list_issues(context: &McpContext, args: &Map<String, Value>) -> Result<Value, String> {
    let state = issue_state(args.get("state"))?;
    let limit = match args.get("limit").and_then(Value::as_f64) {
        Some(value) if value.is_finite() && value.fract() == 0.0 => {
            (value as i64).clamp(1, ISSUE_LIST_MAX as i64) as usize
        }
        _ => ISSUE_LIST_MAX,
    };
    let forge = issues_client(context)?;
    let issues = forge
        .list(query_state(state), Some(limit + 1))
        .await
        .map_err(|error| error.message)?;
    let truncated = issues.len() > limit;
    let rows: Vec<Value> = issues.iter().take(limit).map(issue_row).collect();
    if let Some(directory) = dedup_run_directory(context) {
        std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let record = json!({"count": rows.len(), "at": now_iso()});
        append_line(&directory.join(DEDUP_READ_FILE), &record)
            .map_err(|error| error.to_string())?;
    }
    Ok(json!({"issues": rows, "truncated": truncated}))
}

async fn get_issue(context: &McpContext, args: &Map<String, Value>) -> Result<Value, String> {
    let number = positive_issue_number(args.get("number"))?;
    let forge = issues_client(context)?;
    let issue = forge.get(number).await.map_err(|error| error.message)?;
    let bounded = bound_bytes(&issue.body, ISSUE_BODY_MAX_BYTES, "...");
    Ok(issue_document(&issue, &bounded.text, bounded.truncated))
}

async fn close_issue(context: &McpContext, args: &Map<String, Value>) -> Result<Value, String> {
    let number = positive_issue_number(args.get("number"))?;
    let reason = match args.get("reason").and_then(Value::as_str) {
        None => "completed",
        Some("completed") => "completed",
        Some("not planned") => "not planned",
        Some(_) => return Err("reason must be \"completed\" or \"not planned\".".to_string()),
    };
    let forge = issues_client(context)?;
    let close_reason = if reason == "not planned" {
        CloseReason::NotPlanned
    } else {
        CloseReason::Completed
    };
    let issue = forge
        .close(number, close_reason)
        .await
        .map_err(|error| error.message)?;
    if let Some(run_id) = environment_value(context, "DEVBOARD_ISSUES_RUN_ID") {
        if !run_id.is_empty() {
            crate::issues_mode::record_closed_by_run(
                &context.state_dir,
                &context.repo_dir,
                issue.number.max(0) as u64,
                run_id,
            );
        }
    }
    Ok(json!({"number": issue.number, "state": issue.state.as_str(), "url": issue.url}))
}

fn issue_title(value: Option<&Value>) -> Result<String, String> {
    match value.and_then(Value::as_str) {
        Some(value) if !value.trim().is_empty() => {
            let title = value.trim().to_string();
            if title.contains('\n') || title.contains('\r') {
                return Err("The issue title must be one line.".to_string());
            }
            if byte_len(&title) > ISSUE_TITLE_MAX_BYTES {
                return Err(format!(
                    "The issue title must be at most {ISSUE_TITLE_MAX_BYTES} bytes."
                ));
            }
            Ok(title)
        }
        _ => Err("A one-line issue title is required.".to_string()),
    }
}

fn issue_labels(value: Option<&Value>) -> Result<Vec<String>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let Some(entries) = value.as_array() else {
        return Err("labels must be a list of label names.".to_string());
    };
    let mut labels: Vec<String> = Vec::new();
    for entry in entries {
        let Some(text) = entry.as_str() else {
            return Err("labels must be a list of non-empty label names.".to_string());
        };
        if text.trim().is_empty() {
            return Err("labels must be a list of non-empty label names.".to_string());
        }
        let label = text.trim().to_string();
        if crate::feedback::js_len(&label) > 100 {
            return Err("A label name is longer than 100 characters.".to_string());
        }
        if !labels.contains(&label) {
            labels.push(label);
        }
    }
    Ok(labels)
}

fn normalize_issue_title(title: &str) -> String {
    title
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn draft_goal_headings(repo_dir: &Path) -> Vec<String> {
    let directory = repo_dir.join(".devboard").join("goal-proposals");
    let Ok(entries) = std::fs::read_dir(&directory) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".md"))
        .collect();
    names.sort();
    let mut headings: Vec<String> = Vec::new();
    for name in names {
        let Ok(text) = std::fs::read_to_string(directory.join(&name)) else {
            continue;
        };
        for line in text.split('\n') {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Some(heading) = trimmed.strip_prefix("# ") {
                headings.push(heading.trim().to_string());
            }
            break;
        }
    }
    headings
}

async fn create_issue(context: &McpContext, args: &Map<String, Value>) -> Result<Value, String> {
    let title = issue_title(args.get("title"))?;
    let body = match args.get("body").and_then(Value::as_str) {
        Some(body) if !body.trim().is_empty() => body.to_string(),
        _ => return Err("A non-empty Markdown body is required.".to_string()),
    };
    if byte_len(&body) > ISSUE_BODY_MAX_BYTES {
        return Err(format!(
            "The issue body must be at most {ISSUE_BODY_MAX_BYTES} bytes."
        ));
    }
    let labels = issue_labels(args.get("labels"))?;
    // A watchdog deduplication run files through this tool alone, so the
    // candidate fingerprint is what lets the cycle attribute the created
    // issue. Without the record the turn's filing reads as no decision.
    let dedup_directory = dedup_run_directory(context);
    let fingerprint = match args.get("fingerprint") {
        Some(value) => match value.as_str() {
            Some(text) if !text.trim().is_empty() => Some(text.trim().to_string()),
            _ => return Err("fingerprint must be a non-empty candidate fingerprint.".to_string()),
        },
        None => None,
    };
    if dedup_directory.is_some() && fingerprint.is_none() {
        return Err(
            "fingerprint is required while a watchdog deduplication run records its decisions."
                .to_string(),
        );
    }
    let forge = issues_client(context)?;
    for guarded in [
        (
            "dead-code",
            "dead-code finding",
            "A dead-code title must be at most 200 characters.",
        ),
        (
            "single-responsibility",
            "single-responsibility finding",
            "A single-responsibility title must be at most 200 characters.",
        ),
        (
            "consistent-naming",
            "consistent-naming finding",
            "A consistent-naming title must be at most 200 characters.",
        ),
    ] {
        let (label, noun, title_error) = guarded;
        if !labels.iter().any(|entry| entry == label) {
            continue;
        }
        if title.encode_utf16().count() > 200 {
            return Err(title_error.to_string());
        }
        let mut known: HashSet<String> = HashSet::new();
        for issue in forge
            .list_all(IssueQueryState::All)
            .await
            .map_err(|error| error.message)?
        {
            if issue.state.as_str() == "open" || issue.labels.iter().any(|entry| entry == label) {
                known.insert(normalize_issue_title(&issue.title));
            }
        }
        for heading in draft_goal_headings(&context.repo_dir) {
            known.insert(normalize_issue_title(&heading));
        }
        if known.contains(&normalize_issue_title(&title)) {
            return Err(format!(
                "A {noun} titled \"{title}\" already exists; nothing was filed. The guard compared {} issue titles.",
                known.len()
            ));
        }
    }
    for label in &labels {
        forge
            .ensure_label(label)
            .await
            .map_err(|error| error.message)?;
    }
    let issue = forge
        .create(&CreateForgeIssueInput {
            title,
            body,
            labels,
        })
        .await
        .map_err(|error| error.message)?;
    if let (Some(directory), Some(fingerprint)) = (dedup_directory, fingerprint) {
        record_watchdog_filed(&directory, &fingerprint, &issue)?;
    }
    Ok(json!({
        "number": issue.number,
        "url": issue.url,
        "title": issue.title,
        "labels": issue.labels,
    }))
}

async fn comment_issue(context: &McpContext, args: &Map<String, Value>) -> Result<Value, String> {
    let number = positive_issue_number(args.get("number"))?;
    let body = match args.get("body").and_then(Value::as_str) {
        Some(body) if !body.trim().is_empty() => body.to_string(),
        _ => return Err("A non-empty comment body is required.".to_string()),
    };
    if byte_len(&body) > ISSUE_BODY_MAX_BYTES {
        return Err(format!(
            "The comment body must be at most {ISSUE_BODY_MAX_BYTES} bytes."
        ));
    }
    let forge = issues_client(context)?;
    forge
        .comment(&CommentTarget::Number(number), &body)
        .await
        .map_err(|error| error.message)?;
    Ok(json!({"number": number, "commented": true}))
}

// ---------------------------------------------------------------------------
// Harness controls
// ---------------------------------------------------------------------------

fn known_agent(id: &str) -> bool {
    AGENT_IDS.contains(&id)
}

async fn background_agent_control(
    context: &McpContext,
    args: &Map<String, Value>,
) -> Result<Value, String> {
    let id = match args.get("id").and_then(Value::as_str) {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => return Err("id is required.".to_string()),
    };
    if !known_agent(&id) {
        return Err(format!("Unknown background agent: {id}."));
    }
    let action = match args.get("action").and_then(Value::as_str) {
        Some(value @ ("start" | "stop" | "set_settings" | "disable_timer")) => value.to_string(),
        _ => return Err("action must be start, stop, set_settings, or disable_timer.".to_string()),
    };
    let command = if action == "set_settings" {
        let minutes = args
            .get("minutes")
            .and_then(Value::as_f64)
            .filter(|value| value.fract() == 0.0 && (1.0..=1440.0).contains(value))
            .ok_or_else(|| {
                "The cadence must be an integer from 1 through 1440 minutes.".to_string()
            })?;
        let limit = |name: &str| -> Result<Value, String> {
            match args.get(name) {
                None => Ok(Value::Null),
                Some(Value::Null) => Ok(Value::Null),
                Some(Value::Number(number)) => {
                    let value = number.as_f64().unwrap_or(0.0);
                    if value.fract() != 0.0 || !(1.0..=100.0).contains(&value) {
                        return Err(
                            "Both limits must be empty or integers from 1 through 100.".to_string()
                        );
                    }
                    Ok(json!(value))
                }
                Some(_) => {
                    Err("Both limits must be empty or integers from 1 through 100.".to_string())
                }
            }
        };
        let max_per_hour = limit("maxPerHour")?;
        let max_pending = limit("maxPending")?;
        let mut settings = Map::new();
        settings.insert("type".into(), json!("setAgentSettings"));
        settings.insert("id".into(), json!(id));
        settings.insert("minutes".into(), json!(minutes));
        if args.contains_key("maxPerHour") {
            settings.insert("maxPerHour".into(), max_per_hour);
        }
        if args.contains_key("maxPending") {
            settings.insert("maxPending".into(), max_pending);
        }
        Value::Object(settings)
    } else if action == "disable_timer" {
        json!({"type": "disableAgentTimer", "id": id})
    } else if action == "start" {
        json!({"type": "startAgent", "id": id})
    } else {
        json!({"type": "stopAgent", "id": id})
    };
    let dashboard = select_dashboard(context)?;
    let wanted = id.clone();
    let reply = dashboard_command(
        &dashboard,
        command,
        move |candidate| {
            candidate.get("type").and_then(Value::as_str) == Some("agentState")
                && candidate
                    .get("agent")
                    .and_then(Value::as_object)
                    .and_then(|agent| agent.get("id"))
                    .and_then(Value::as_str)
                    == Some(wanted.as_str())
        },
        20_000,
    )
    .await?;
    let agent = reply
        .get("agent")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    Ok(json!({"id": id, "action": action, "agent": agent}))
}

async fn issues_control(context: &McpContext, args: &Map<String, Value>) -> Result<Value, String> {
    let action = match args.get("action").and_then(Value::as_str) {
        Some(value @ ("start" | "pause" | "resume" | "stop" | "check_now")) => value.to_string(),
        _ => return Err("action must be start, pause, resume, stop, or check_now.".to_string()),
    };
    let kind = match action.as_str() {
        "start" => "startIssues",
        "pause" => "pauseIssues",
        "resume" => "resumeIssues",
        "stop" => "stopIssues",
        _ => "checkIssues",
    };
    let command = if action == "start" {
        json!({"type": kind})
    } else {
        json!([{"type": kind}, {"type": "getIssues"}])
    };
    let dashboard = select_dashboard(context)?;
    let reply = dashboard_command(
        &dashboard,
        command,
        |candidate| candidate.get("type").and_then(Value::as_str) == Some("issuesState"),
        20_000,
    )
    .await?;
    Ok(json!({"action": action, "issues": strip_type(&reply)}))
}

async fn lifecycle_control(
    context: &McpContext,
    args: &Map<String, Value>,
) -> Result<Value, String> {
    let Some(action) = args.get("action").and_then(Value::as_str) else {
        return Err("action is required.".to_string());
    };
    let command = match action {
        "start" => json!({"type": "startLifecycle"}),
        "pause" => json!({"type": "pauseLifecycle"}),
        "resume" => json!({"type": "resumeLifecycle"}),
        "stop" => json!({"type": "stopLifecycle"}),
        "start_run" => {
            let (_, relative) =
                resolve_contained(&context.repo_dir, args.get("file"), "file", true)?;
            if !relative.starts_with("adrs/") || !relative.ends_with(".md") {
                return Err("start_run needs a repository-relative adrs/*.md file.".to_string());
            }
            json!({"type": "startRun", "file": relative})
        }
        _ => return Err("action must be start, pause, resume, stop, or start_run.".to_string()),
    };
    let accepted: Vec<&str> = match action {
        "start_run" => vec!["lifecycleState", "runStarted"],
        _ => vec!["lifecycleState"],
    };
    let action_name = action.to_string();
    let accept = move |candidate: &Value| {
        let Some(kind) = candidate.get("type").and_then(Value::as_str) else {
            return false;
        };
        if !accepted.contains(&kind) {
            return false;
        }
        kind != "runStarted" || candidate.get("manual").and_then(Value::as_bool) == Some(true)
    };
    let dashboard = select_dashboard(context)?;
    let reply = dashboard_command(&dashboard, command, accept, 20_000).await?;
    Ok(json!({
        "action": action_name,
        "goal": goal_text(context).get("goal").cloned().unwrap_or(Value::Null),
        "event": reply,
    }))
}

async fn goal_control(context: &McpContext, args: &Map<String, Value>) -> Result<Value, String> {
    let action = match args.get("action").and_then(Value::as_str) {
        Some(value @ ("create" | "revise" | "prepare_skills" | "reset_implementation")) => {
            value.to_string()
        }
        _ => {
            return Err(
                "action must be create, revise, prepare_skills, or reset_implementation."
                    .to_string(),
            )
        }
    };
    let kind = match action.as_str() {
        "create" => "createGoal",
        "revise" => "reviseGoal",
        "prepare_skills" => "prepareSkills",
        _ => "resetImplementation",
    };
    let mut command = Map::new();
    command.insert("type".into(), json!(kind));
    if action == "revise" {
        let Some(request) = args.get("request").and_then(Value::as_str) else {
            return Err("revise needs a request.".to_string());
        };
        command.insert("request".into(), json!(request));
    }
    let accepted: Vec<&str> = match action.as_str() {
        "create" => vec!["goalCreationStarted"],
        "revise" => vec!["goalRevisionStarted"],
        "prepare_skills" => vec!["skillsPreparationStarted", "skillsState"],
        _ => vec!["implementationResetStarted"],
    };
    let dashboard = select_dashboard(context)?;
    let reply = dashboard_command(
        &dashboard,
        Value::Object(command),
        move |candidate| {
            candidate
                .get("type")
                .and_then(Value::as_str)
                .map(|kind| accepted.contains(&kind))
                .unwrap_or(false)
        },
        20_000,
    )
    .await?;
    Ok(json!({
        "action": action,
        "goal": goal_text(context).get("goal").cloned().unwrap_or(Value::Null),
        "event": strip_type(&reply),
    }))
}

async fn flow_control(context: &McpContext, args: &Map<String, Value>) -> Result<Value, String> {
    let action = match args.get("action").and_then(Value::as_str) {
        Some(value @ ("create_goal" | "start_implementation" | "stop_implementation")) => {
            value.to_string()
        }
        _ => {
            return Err(
                "action must be create_goal, start_implementation, or stop_implementation."
                    .to_string(),
            )
        }
    };
    let kind = match action.as_str() {
        "create_goal" => "createFlowGoal",
        "start_implementation" => "startFlowImplementation",
        _ => "stopFlowImplementation",
    };
    let dashboard = select_dashboard(context)?;
    let reply = dashboard_command(
        &dashboard,
        json!({"type": kind}),
        |candidate| {
            matches!(
                candidate.get("type").and_then(Value::as_str),
                Some("flowSnapshot") | Some("flowError")
            )
        },
        20_000,
    )
    .await?;
    if reply.get("type").and_then(Value::as_str) == Some("flowError") {
        return Err(reply
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("the dashboard refused the Flow command")
            .to_string());
    }
    Ok(json!({"action": action, "flow": strip_type(&reply)}))
}

// ---------------------------------------------------------------------------
// Background agent reads
// ---------------------------------------------------------------------------

async fn background_agents_list(context: &McpContext) -> Result<Value, String> {
    let dashboards = dashboards_for(context);
    if dashboards.len() == 1 {
        if let Some(dashboard) = dashboards.first() {
            let reply = dashboard_command(
                dashboard,
                json!({"type": "getAgents"}),
                |candidate| candidate.get("type").and_then(Value::as_str) == Some("agentsState"),
                20_000,
            )
            .await?;
            if let Some(agents) = reply.get("agents").and_then(Value::as_array) {
                return Ok(Value::Array(agents.clone()));
            }
        }
    }
    Ok(Value::Array(crate::agents_mode::persisted_snapshots(
        &context.state_dir,
        &context.repo_dir,
    )))
}

async fn background_agent_get(context: &McpContext, id: &str) -> Result<Value, String> {
    if !known_agent(id) {
        return Err(format!("Unknown background agent: {id}."));
    }
    let dashboards = dashboards_for(context);
    if dashboards.len() == 1 {
        if let Some(dashboard) = dashboards.first() {
            let wanted = id.to_string();
            let reply = dashboard_command(
                dashboard,
                json!({"type": "getAgent", "id": id}),
                move |candidate| {
                    candidate.get("type").and_then(Value::as_str) == Some("agentState")
                        && candidate
                            .get("agent")
                            .and_then(Value::as_object)
                            .and_then(|agent| agent.get("id"))
                            .and_then(Value::as_str)
                            == Some(wanted.as_str())
                },
                20_000,
            )
            .await?;
            return Ok(reply.get("agent").cloned().unwrap_or(Value::Null));
        }
    }
    crate::agents_mode::persisted_snapshots(&context.state_dir, &context.repo_dir)
        .into_iter()
        .find(|agent| agent.get("id").and_then(Value::as_str) == Some(id))
        .ok_or_else(|| format!("Unknown background agent: {id}."))
}

// ---------------------------------------------------------------------------
// Entry-point picker
// ---------------------------------------------------------------------------

const SKIPPED_DIRECTORIES: [&str; 5] = [".git", "node_modules", "dist", ".worktree", ".tmp"];
const TEXT_SAMPLE_BYTES: usize = 8192;

fn skipped_relpath(path: &str) -> bool {
    if path
        .split('/')
        .any(|part| SKIPPED_DIRECTORIES.contains(&part))
    {
        return true;
    }
    path == ".devboard/.tmp" || path.starts_with(".devboard/.tmp/")
}

fn walk_pool(root: &Path) -> Result<Vec<String>, String> {
    fn visit(directory: &Path, prefix: &str, files: &mut Vec<String>) -> Result<(), String> {
        let entries = std::fs::read_dir(directory).map_err(|error| {
            format!(
                "the repository root {} is not readable: {error}",
                directory.display()
            )
        })?;
        let mut children: Vec<std::fs::DirEntry> = entries.flatten().collect();
        children.sort_by_key(|entry| entry.file_name());
        for entry in children {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let relative = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            if kind.is_dir() {
                if skipped_relpath(&relative) {
                    continue;
                }
                visit(&entry.path(), &relative, files)?;
            } else if kind.is_file() && !skipped_relpath(&relative) {
                files.push(relative);
            }
        }
        Ok(())
    }
    let mut files: Vec<String> = Vec::new();
    visit(root, "", &mut files)?;
    files.sort();
    Ok(files)
}

fn git_output(root: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .ok()?;
    output.status.success().then_some(output.stdout)
}

fn git_work_tree(root: &Path) -> bool {
    let Ok(real) = std::fs::canonicalize(root) else {
        return false;
    };
    let Some(output) = git_output(root, &["rev-parse", "--show-toplevel"]) else {
        return false;
    };
    let top = String::from_utf8_lossy(&output).trim().to_string();
    if top.is_empty() {
        return false;
    }
    std::fs::canonicalize(&top)
        .map(|value| value == real)
        .unwrap_or(false)
}

fn git_paths(root: &Path, args: &[&str]) -> Option<Vec<String>> {
    let output = git_output(root, args)?;
    Some(
        String::from_utf8_lossy(&output)
            .split('\0')
            .filter(|path| !path.is_empty())
            .map(str::to_string)
            .collect(),
    )
}

fn regular_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_file())
        .unwrap_or(false)
}

/// The paths among `paths` that git itself excludes.
///
/// `git check-ignore` reports only untracked matches, so a tracked file that
/// happens to match a broad rule stays admitted; asking with `--no-index`
/// would exclude repository content a host keeps tracked.
fn git_ignored_among(root: &Path, paths: &[String]) -> Option<HashSet<String>> {
    use std::io::Write;
    if paths.is_empty() {
        return Some(HashSet::new());
    }
    let mut child = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["check-ignore", "-z", "--stdin"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    {
        let stdin = child.stdin.as_mut()?;
        for path in paths {
            stdin.write_all(path.as_bytes()).ok()?;
            stdin.write_all(b"\0").ok()?;
        }
    }
    let output = child.wait_with_output().ok()?;
    if output.status.code() != Some(0) && output.status.code() != Some(1) {
        return None;
    }
    Some(
        String::from_utf8_lossy(&output.stdout)
            .split('\0')
            .filter(|path| !path.is_empty())
            .map(str::to_string)
            .collect(),
    )
}

fn git_admitted_files(root: &Path) -> Option<Vec<String>> {
    if !git_work_tree(root) {
        return None;
    }
    let paths = git_paths(
        root,
        &[
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ],
    )?;
    let ignored = git_ignored_among(root, &paths)?;
    let mut files: Vec<String> = Vec::new();
    for path in paths {
        if skipped_relpath(&path) || ignored.contains(&path) {
            continue;
        }
        let absolute = resolve_path(&root.join(&path));
        if !absolute.starts_with(root) || !regular_file(&absolute) {
            continue;
        }
        files.push(path);
    }
    files.sort();
    Some(files)
}

fn sample_bytes(path: &Path) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    let mut buffer = vec![0u8; TEXT_SAMPLE_BYTES];
    let read = file.read(&mut buffer).ok()?;
    buffer.truncate(read);
    Some(buffer)
}

fn is_text_file(path: &Path) -> bool {
    let Some(bytes) = sample_bytes(path) else {
        return false;
    };
    if bytes.contains(&0) {
        return false;
    }
    let mut control = 0usize;
    let mut visible = false;
    for byte in &bytes {
        if *byte < 32 && *byte != 9 && *byte != 10 && *byte != 13 {
            control += 1;
        }
        if *byte > 32 {
            visible = true;
        }
    }
    visible && !bytes.is_empty() && (control as f64) / (bytes.len() as f64) < 0.1
}

fn scout_pool(root: &Path) -> Vec<String> {
    let files = git_admitted_files(root).unwrap_or_else(|| walk_pool(root).unwrap_or_default());
    files
        .into_iter()
        .filter(|path| is_text_file(&root.join(path)))
        .collect()
}

fn code_line() -> &'static regex::Regex {
    static VALUE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(
            r"(?m)^\s*(?:import|export|from|class|def|function|const|let|var|interface|type|enum|package|use|#include|public|private|protected|func|fn|impl|module|namespace|struct|trait|async|await|return|if|for|while|switch|case)\b",
        )
        .expect("a code regex")
    });
    &VALUE
}

fn rule_line() -> &'static regex::Regex {
    static VALUE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?m)^\s*[.#@&*:a-zA-Z][^{}\n]*\{[^}\n]*$").expect("a rule regex")
    });
    &VALUE
}

fn read_head(path: &Path) -> String {
    sample_bytes(path)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default()
}

fn extension_of(path: &str) -> String {
    Path::new(path)
        .extension()
        .map(|value| format!(".{}", value.to_string_lossy().to_lowercase()))
        .unwrap_or_default()
}

fn discover_source_extensions(root: &Path) -> HashSet<String> {
    let mut extensions: HashSet<String> = HashSet::new();
    for path in scout_pool(root) {
        let extension = extension_of(&path);
        if extension.is_empty() || extensions.contains(&extension) {
            continue;
        }
        let head = read_head(&root.join(&path));
        if code_line().is_match(&head) || rule_line().is_match(&head) {
            extensions.insert(extension);
        }
    }
    extensions
}

fn dead_code_pool(root: &Path) -> Vec<String> {
    let extensions = discover_source_extensions(root);
    let mut files: Vec<String> = scout_pool(root)
        .into_iter()
        .filter(|path| extensions.contains(&extension_of(path)))
        .collect();
    files.sort();
    files
}

fn is_test_file(path: &str) -> bool {
    static VALUE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"\.(test|spec)\.").expect("a test regex"));
    VALUE.is_match(path)
}

fn is_component_path(path: &str) -> bool {
    let parts: Vec<&str> = path.split('/').collect();
    let directories = &parts[..parts.len().saturating_sub(1)];
    !directories
        .iter()
        .any(|directory| matches!(*directory, "fixtures" | "tests" | "stubs"))
}

fn non_source_extension(extension: &str) -> bool {
    matches!(
        extension,
        ".md" | ".markdown" | ".txt" | ".json" | ".yml" | ".yaml" | ".toml" | ".lock"
    )
}

fn single_responsibility_pool(root: &Path) -> Vec<String> {
    let mut files: Vec<String> = dead_code_pool(root)
        .into_iter()
        .filter(|path| {
            !is_test_file(path)
                && is_component_path(path)
                && !non_source_extension(&extension_of(path))
        })
        .collect();
    files.sort();
    files
}

/// The consistent-naming pool: the same component source set, because a
/// concept's name is audited in code, never in a test, a fixture, or a stub.
fn consistent_naming_pool(root: &Path) -> Vec<String> {
    single_responsibility_pool(root)
}

fn design_pool(root: &Path, environment: &HashMap<String, String>) -> Result<Vec<String>, String> {
    let configured = |key: &str, fallback: &str| -> String {
        environment
            .get(key)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| fallback.to_string())
    };
    let source_dir = configured("DESIGN_SOURCE_DIR", ".devboard/client");
    if source_dir != ".devboard/client" && !source_dir.ends_with("/client") {
        return Err(format!(
            "the design pool is empty: the audit source {source_dir} is not an interface source directory"
        ));
    }
    let source_root = resolve_path(&root.join(&source_dir));
    if !source_root.is_dir() {
        return Err(format!(
            "the design pool is empty: the canonical harness source checkout has no {source_dir} directory (an installed npm prefix is refused)"
        ));
    }
    let index_candidates = [
        source_root.join("index.html"),
        source_root.join("..").join("index.html"),
    ];
    if !index_candidates.iter().any(|candidate| candidate.is_file()) {
        return Err(format!(
            "the design pool is empty: {source_dir} has no index.html entry"
        ));
    }
    let mut files: Vec<String> = Vec::new();
    fn walk(directory: &Path, root: &Path, files: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(directory) else {
            return;
        };
        let mut ordered: Vec<std::fs::DirEntry> = entries.flatten().collect();
        ordered.sort_by_key(|entry| entry.file_name());
        for entry in ordered {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                walk(&entry.path(), root, files);
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if !kind.is_file()
                || !(name.ends_with(".svelte") || name.ends_with(".css") || name.ends_with(".ts"))
            {
                continue;
            }
            files.push(relative_to(root, &entry.path()));
        }
    }
    walk(&source_root, root, &mut files);
    let mut pooled: Vec<String> = files
        .into_iter()
        .filter(|path| is_text_file(&root.join(path)))
        .collect();
    pooled.sort();
    Ok(pooled)
}

fn eligible_files(
    root: &Path,
    surface: &str,
    environment: &HashMap<String, String>,
) -> Result<Vec<String>, String> {
    match surface {
        "scout" => Ok(scout_pool(root)),
        "design" => design_pool(root, environment),
        "dead-code" => Ok(dead_code_pool(root)),
        "consistent-naming" => Ok(consistent_naming_pool(root)),
        _ => Ok(single_responsibility_pool(root)),
    }
}

fn pick_entry_point(context: &McpContext, args: &Map<String, Value>) -> Result<Value, String> {
    let Some(surface) = args.get("surface").and_then(Value::as_str) else {
        return Err(format!(
            "unknown entry-point surface undefined; use one of {}",
            ENTRY_POINT_SURFACES.join(", ")
        ));
    };
    if !ENTRY_POINT_SURFACES.contains(&surface) {
        return Err(format!(
            "unknown entry-point surface {surface}; use one of {}",
            ENTRY_POINT_SURFACES.join(", ")
        ));
    }
    if let Some(seed) = args.get("seed") {
        if !seed.is_string() {
            return Err("the entry-point seed must be a string when it is given".to_string());
        }
    }
    let root = resolve_path(&context.repo_dir);
    let Ok(root_real) = std::fs::canonicalize(&root) else {
        return Err(format!(
            "the repository root {} does not exist",
            root.display()
        ));
    };
    let files = eligible_files(&root, surface, &context.environment)?;
    if files.is_empty() {
        return Err(format!(
            "the {surface} entry-point pool has no eligible file"
        ));
    }
    let seed = match args.get("seed").and_then(Value::as_str) {
        Some(seed) if !seed.is_empty() => seed.to_string(),
        _ => {
            use rand::RngCore;
            let mut bytes = [0u8; 16];
            rand::thread_rng().fill_bytes(&mut bytes);
            hex::encode(bytes)
        }
    };
    let mut hasher = Sha256::new();
    hasher.update(format!("{surface}\u{0}{seed}").as_bytes());
    let hash = hasher.finalize();
    let first = u32::from_be_bytes([hash[0], hash[1], hash[2], hash[3]]) as usize;
    let path = files[first % files.len()].clone();
    let absolute = resolve_path(&root.join(&path));
    if !absolute.starts_with(&root) {
        return Err(format!(
            "the {surface} entry point leaves the repository: {path}"
        ));
    }
    if ignored_path(&root, &path) {
        return Err(format!(
            "the {surface} entry point {path} is excluded by the repository's ignore rules"
        ));
    }
    let Ok(real) = std::fs::canonicalize(&absolute) else {
        return Err(format!("the {surface} entry point {path} is not readable"));
    };
    if !real.starts_with(&root_real) {
        return Err(format!(
            "the {surface} entry point resolves outside the repository: {path}"
        ));
    }
    let Ok(text) = std::fs::read_to_string(&real) else {
        return Err(format!("the {surface} entry point {path} is not readable"));
    };
    let body = text.strip_suffix('\n').unwrap_or(&text);
    let candidates: Vec<usize> = body
        .split('\n')
        .enumerate()
        .filter(|(_, line)| !line.trim().is_empty())
        .map(|(index, _)| index)
        .collect();
    if candidates.is_empty() {
        return Err(format!(
            "the entry point {path} has no non-blank line to name"
        ));
    }
    let second = u32::from_be_bytes([hash[4], hash[5], hash[6], hash[7]]) as usize;
    let line = candidates[second % candidates.len()] + 1;
    Ok(json!({"path": path, "line": line, "surface": surface, "seed": seed}))
}

/// Whether git itself excludes this path; a tracked path never is.
fn ignored_path(root: &Path, relative: &str) -> bool {
    if !git_work_tree(root) {
        return false;
    }
    match Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["check-ignore", "-q", "--", relative])
        .status()
    {
        Ok(status) => status.success(),
        Err(_) => false,
    }
}

// ---------------------------------------------------------------------------
// Verification runs
// ---------------------------------------------------------------------------

static RUN_LOG_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

fn sanitized_check(check: &str) -> String {
    let mut name = String::new();
    let mut dash = false;
    for character in check.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-') {
            name.push(character);
            dash = false;
        } else if !dash {
            name.push('-');
            dash = true;
        }
    }
    name
}

fn verification_log_path(context: &McpContext, check: &str) -> PathBuf {
    context
        .state_dir
        .join(format!("{}.log", sanitized_check(check)))
}

fn verification_run_log_path(context: &McpContext, check: &str) -> PathBuf {
    let sequence = RUN_LOG_SEQUENCE.fetch_add(1, Ordering::SeqCst) + 1;
    context.state_dir.join(format!(
        "{}.{}.{}.log",
        sanitized_check(check),
        std::process::id(),
        sequence
    ))
}

fn package_scripts(context: &McpContext) -> Result<Map<String, Value>, String> {
    let path = context.harness_dir.join("package.json");
    let text = std::fs::read_to_string(&path).map_err(|_| {
        format!(
            "Cannot read {}; .devboard/package.json is required.",
            path.to_string_lossy()
        )
    })?;
    let parsed: Value = serde_json::from_str(&text).map_err(|_| {
        format!(
            "Cannot read {}; .devboard/package.json is required.",
            path.to_string_lossy()
        )
    })?;
    let Some(record) = parsed.as_object() else {
        return Err(".devboard/package.json carries no scripts.".to_string());
    };
    let Some(scripts) = record.get("scripts").and_then(Value::as_object) else {
        return Err(".devboard/package.json carries no scripts.".to_string());
    };
    let mut result = Map::new();
    for (name, body) in scripts {
        if body.is_string() {
            result.insert(name.clone(), body.clone());
        }
    }
    Ok(result)
}

fn test_paths(context: &McpContext, value: Option<&Value>) -> Result<Vec<String>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let Some(entries) = value.as_array() else {
        return Err("paths must be an array of repository-relative paths.".to_string());
    };
    if entries.len() > VERIFICATION_PATH_MAX {
        return Err(format!(
            "At most {VERIFICATION_PATH_MAX} test paths are accepted."
        ));
    }
    let harness = resolve_path(&context.harness_dir);
    let mut paths: Vec<String> = Vec::new();
    for entry in entries {
        let (absolute, _) =
            resolve_contained(&context.harness_dir, Some(entry), "test path", true)?;
        if !absolute.starts_with(&harness) {
            return Err(format!(
                "A test path must stay inside .devboard: {}",
                js_string(entry)
            ));
        }
        let local = relative_to(&harness, &absolute);
        paths.push(format!("./{local}"));
    }
    Ok(paths)
}

fn captured_output(
    stdout: &[u8],
    stderr: &[u8],
    max_bytes: usize,
    overflowed: bool,
) -> (String, bool) {
    let mut combined = stdout.to_vec();
    combined.extend_from_slice(stderr);
    if !overflowed && combined.len() <= max_bytes {
        return (String::from_utf8_lossy(&combined).into_owned(), false);
    }
    let prefix = String::from_utf8_lossy(&combined[..combined.len().min(max_bytes)]).into_owned();
    (format!("{prefix}\n[output truncated]"), true)
}

struct PipeState {
    chunks: Vec<u8>,
    overflowed: bool,
}

async fn run_verification(
    context: &McpContext,
    args: &Map<String, Value>,
) -> Result<Value, String> {
    run_verification_with(
        context,
        args,
        VERIFICATION_TIMEOUT_MS,
        VERIFICATION_OUTPUT_MAX_BYTES,
    )
    .await
}

async fn run_verification_with(
    context: &McpContext,
    args: &Map<String, Value>,
    timeout_ms: u64,
    output_max_bytes: usize,
) -> Result<Value, String> {
    let timeout_ms = timeout_ms.max(1);
    let output_max_bytes = output_max_bytes.max(1);
    let Some(check) = args
        .get("check")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    else {
        return Err("A check name is required.".to_string());
    };
    // The Rust checks run the harness's own toolchain from the harness
    // directory. They need no `package.json`, so they are resolved before the
    // client scripts are read.
    let rust_argv: Option<Vec<String>> = match check {
        "rust:fmt" => Some(vec![
            "cargo".into(),
            "fmt".into(),
            "--check".into(),
            "--all".into(),
        ]),
        "rust:clippy" => Some(vec![
            "cargo".into(),
            "clippy".into(),
            "--workspace".into(),
            "--all-targets".into(),
            "--".into(),
            "-D".into(),
            "warnings".into(),
        ]),
        "rust:test" => Some(vec!["cargo".into(), "test".into(), "--workspace".into()]),
        _ => None,
    };
    let argv: Vec<String> = if let Some(argv) = rust_argv {
        argv
    } else if check == "test" {
        package_scripts(context)?;
        let mut argv = vec!["bun".to_string(), "test".to_string()];
        argv.extend(test_paths(context, args.get("paths"))?);
        argv
    } else if check == "typecheck" {
        let available = package_scripts(context)?;
        if available.contains_key("typecheck") {
            vec!["bun".into(), "run".into(), "typecheck".into()]
        } else {
            vec!["bunx".into(), "tsc".into(), "--noEmit".into()]
        }
    } else if check == "check" || check == "build" {
        let available = package_scripts(context)?;
        let Some(Value::String(script)) = available.get(check) else {
            return Err(format!(".devboard/package.json has no \"{check}\" script."));
        };
        // The harness itself needs no JavaScript runtime; the host's declared
        // script is executed as written by a POSIX shell.
        vec!["sh".into(), "-c".into(), script.clone()]
    } else if let Some(name) = check.strip_prefix("verify:") {
        if name.is_empty() {
            return Err(format!(".devboard/package.json has no \"{check}\" script."));
        }
        let available = package_scripts(context)?;
        let Some(Value::String(script)) = available.get(check) else {
            return Err(format!(".devboard/package.json has no \"{check}\" script."));
        };
        vec!["sh".into(), "-c".into(), script.clone()]
    } else {
        return Err(format!(
            "Unknown check: {check}. Allowed checks: test, check, build, typecheck, verify:<name>, rust:fmt, rust:clippy, rust:test."
        ));
    };
    let cwd = resolve_path(&context.harness_dir);
    if !cwd.exists() {
        return Err(format!("{} does not exist.", cwd.to_string_lossy()));
    }
    let stable_path = verification_log_path(context, check);
    let log_path = verification_run_log_path(context, check);
    if let Some(parent) = log_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let log_file = tokio::fs::File::create(&log_path)
        .await
        .map_err(|error| error.to_string())?;
    let log = std::sync::Arc::new(tokio::sync::Mutex::new(log_file));
    let log_relative = relative_to(&resolve_path(&context.repo_dir), &resolve_path(&log_path));

    let mut command = tokio::process::Command::new(&argv[0]);
    command.args(&argv[1..]);
    command.current_dir(&cwd);
    command.stdin(std::process::Stdio::null());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    command.envs(context.environment.iter());
    if !context.environment.contains_key("CI") {
        command.env("CI", "1");
    }
    command.env("NO_COLOR", "1");
    #[cfg(unix)]
    command.process_group(0);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            drop(log);
            let staged = log_path.with_extension("log.stable.tmp");
            if std::fs::copy(&log_path, &staged)
                .and_then(|_| std::fs::rename(&staged, &stable_path))
                .is_err()
            {
                let _ = std::fs::remove_file(&staged);
            }
            return Err(error.to_string());
        }
    };
    let pid = child.id();
    let stdout = std::sync::Arc::new(tokio::sync::Mutex::new(PipeState {
        chunks: Vec::new(),
        overflowed: false,
    }));
    let stderr = std::sync::Arc::new(tokio::sync::Mutex::new(PipeState {
        chunks: Vec::new(),
        overflowed: false,
    }));
    let mut readers = Vec::new();
    if let Some(pipe) = child.stdout.take() {
        readers.push(tokio::spawn(read_pipe(
            pipe,
            output_max_bytes,
            log.clone(),
            stdout.clone(),
        )));
    }
    if let Some(pipe) = child.stderr.take() {
        readers.push(tokio::spawn(read_pipe(
            pipe,
            output_max_bytes,
            log.clone(),
            stderr.clone(),
        )));
    }
    let waited = tokio::time::timeout(Duration::from_millis(timeout_ms), child.wait()).await;
    let (exit_code, timed_out) = match waited {
        Ok(Ok(status)) => (status.code(), false),
        Ok(Err(_)) => (Some(-1), false),
        Err(_) => {
            #[cfg(unix)]
            if let Some(pid) = pid {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
            let _ = child.kill().await;
            (None, true)
        }
    };
    for mut reader in readers {
        if tokio::time::timeout(Duration::from_secs(5), &mut reader)
            .await
            .is_err()
        {
            reader.abort();
        }
    }
    let stdout_bytes = stdout.lock().await;
    let stderr_bytes = stderr.lock().await;
    let combined_overflow = stdout_bytes.overflowed || stderr_bytes.overflowed;
    let (mut output, truncated) = captured_output(
        &stdout_bytes.chunks,
        &stderr_bytes.chunks,
        output_max_bytes,
        combined_overflow,
    );
    if timed_out {
        output.push_str(&format!("\n[timed out after {timeout_ms} ms]"));
    }
    drop(stdout_bytes);
    drop(stderr_bytes);
    drop(log);
    let staged = log_path.with_extension("log.stable.tmp");
    let published =
        std::fs::copy(&log_path, &staged).and_then(|_| std::fs::rename(&staged, &stable_path));
    if published.is_err() {
        let _ = std::fs::remove_file(&staged);
    }
    Ok(json!({
        "check": check,
        "exitCode": if timed_out { Value::Null } else { json!(exit_code) },
        "output": output,
        "truncated": truncated,
        "log": log_relative,
    }))
}

async fn read_pipe<R>(
    mut pipe: R,
    limit: usize,
    log: std::sync::Arc<tokio::sync::Mutex<tokio::fs::File>>,
    state: std::sync::Arc<tokio::sync::Mutex<PipeState>>,
) where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;
    use tokio::io::AsyncWriteExt;
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = match pipe.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(read) => read,
        };
        {
            let mut file = log.lock().await;
            let _ = file.write_all(&buffer[..read]).await;
        }
        let mut state = state.lock().await;
        let room = limit.saturating_sub(state.chunks.len());
        if room == 0 {
            state.overflowed = true;
            continue;
        }
        let kept = read.min(room);
        state.chunks.extend_from_slice(&buffer[..kept]);
        if kept < read {
            state.overflowed = true;
        }
    }
}

#[cfg(test)]
mod title_tests {
    use super::*;

    #[test]
    fn the_goal_title_cap_counts_utf16_units() {
        let too_long = Value::String("😀".repeat(101));
        assert!(valid_goal_title(Some(&too_long)).is_err());
        let at_cap = Value::String("😀".repeat(100));
        assert!(valid_goal_title(Some(&at_cap)).is_ok());
        let plain = Value::String("a".repeat(200));
        assert!(valid_goal_title(Some(&plain)).is_ok());
    }

    #[test]
    fn the_label_cap_counts_utf16_units() {
        let emoji_over = Value::Array(vec![Value::String("😀".repeat(51))]);
        assert!(issue_labels(Some(&emoji_over)).is_err());
        let emoji_at_cap = Value::Array(vec![Value::String("😀".repeat(50))]);
        assert!(issue_labels(Some(&emoji_at_cap)).is_ok());
        let plain_at_cap = Value::Array(vec![Value::String("a".repeat(100))]);
        assert!(issue_labels(Some(&plain_at_cap)).is_ok());
        let plain_over = Value::Array(vec![Value::String("a".repeat(101))]);
        assert!(issue_labels(Some(&plain_over)).is_err());
    }
}
