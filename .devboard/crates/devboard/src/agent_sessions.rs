//! One reader for the ACP peer transcripts the dashboard's generated agent
//! directories hold. MCP optimizer and the Devboard MCP server both read
//! sessions through this module: the record shapes, the token and cost
//! summation, and the tool-error fingerprint are defined once here.
//!
//! A transcript is JSONL. The records this module understands are `session`
//! (id, start time, cwd), `title`, and `message` (user, assistant, toolResult).
//! Anything else is skipped; a malformed line is counted, never guessed.

use std::path::{Component, Path, PathBuf};

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use time::format_description::FormatItem;
use time::macros::format_description;
use time::{Date, Month, OffsetDateTime, PrimitiveDateTime, Time};

pub const SESSION_LIST_DEFAULT_LIMIT: usize = 50;
pub const SESSION_LIST_MAX_LIMIT: usize = 200;
pub const SESSION_READ_DEFAULT_LIMIT: usize = 50;
pub const SESSION_READ_MAX_LIMIT: usize = 200;
pub const SESSION_RESPONSE_MAX_BYTES: usize = 64 * 1024;
pub const SESSION_SEARCH_MAX_MATCHES: usize = 100;
pub const SESSION_SEARCH_SNIPPET_MAX: usize = 200;
pub const SESSION_MESSAGE_TEXT_MAX: usize = 4_000;
/// The newest selected transcript files one cycle may read.
pub const SESSION_MAX_FILES: usize = 1_000;

/// How much of a transcript the header scan reads before giving up.
const HEADER_SCAN_BYTES: u64 = 64 * 1024;

fn iso_format() -> &'static [FormatItem<'static>] {
    static FORMAT: std::sync::LazyLock<Vec<FormatItem<'static>>> = std::sync::LazyLock::new(|| {
        format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z")
            .to_vec()
    });
    &FORMAT
}

/// `new Date(millis).toISOString()`.
pub fn iso_from_millis(millis: i64) -> String {
    let seconds = millis.div_euclid(1_000);
    let nanos = millis.rem_euclid(1_000) * 1_000_000;
    match OffsetDateTime::from_unix_timestamp(seconds) {
        Ok(instant) => {
            let instant = instant.replace_nanosecond(nanos as u32).unwrap_or(instant);
            instant
                .format(iso_format())
                .unwrap_or_else(|_| String::new())
        }
        Err(_) => String::new(),
    }
}

/// The parsed instant in epoch milliseconds, or `None` when unusable.
pub fn parse_session_instant(value: &Value) -> Option<i64> {
    let text = value.as_str()?;
    if text.is_empty() {
        return None;
    }
    parse_instant_text(text)
}

fn digits(text: &str) -> Option<i64> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// A strict ISO 8601 reader for the shapes the transcripts carry.
pub fn parse_instant_text(text: &str) -> Option<i64> {
    let value = text.trim();
    if !value.is_ascii() {
        return None;
    }
    let bytes = value.as_bytes();
    if bytes.len() < 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let year = digits(&value[0..4])? as i32;
    let month = digits(&value[5..7])? as u32;
    let day = digits(&value[8..10])? as u32;
    let month = Month::try_from(u8::try_from(month).ok()?).ok()?;
    let date = Date::from_calendar_date(year, month, u8::try_from(day).ok()?).ok()?;
    if value.len() == 10 {
        return Some(to_millis(
            PrimitiveDateTime::new(date, Time::MIDNIGHT).assume_utc(),
        ));
    }
    let separator = bytes.get(10).copied()?;
    if separator != b'T' && separator != b' ' {
        return None;
    }
    let clock = value.get(11..)?;
    if clock.len() < 8 || clock.as_bytes()[2] != b':' || clock.as_bytes()[5] != b':' {
        return None;
    }
    let hour = digits(&clock[0..2])? as u8;
    let minute = digits(&clock[3..5])? as u8;
    let second = digits(&clock[6..8])? as u8;
    let mut rest = &clock[8..];
    let mut nanos: u32 = 0;
    if let Some(fraction) = rest.strip_prefix('.') {
        let count = fraction
            .bytes()
            .take_while(|byte| byte.is_ascii_digit())
            .count();
        let digits = &fraction[..count];
        rest = &fraction[count..];
        if !digits.is_empty() {
            let mut padded = digits.chars().take(9).collect::<String>();
            while padded.len() < 9 {
                padded.push('0');
            }
            nanos = padded.parse().unwrap_or(0);
        }
    }
    let offset = if rest.is_empty() || rest == "Z" || rest == "z" {
        0i64
    } else if let Some(offset) = rest.strip_prefix('+') {
        parse_offset(offset)?
    } else if let Some(offset) = rest.strip_prefix('-') {
        -parse_offset(offset)?
    } else {
        return None;
    };
    let time = Time::from_hms_nano(hour, minute, second, nanos).ok()?;
    let instant = PrimitiveDateTime::new(date, time).assume_utc();
    Some(to_millis(instant) - offset * 1000)
}

fn parse_offset(text: &str) -> Option<i64> {
    if text.len() != 5 || text.as_bytes()[2] != b':' {
        return None;
    }
    let hours = digits(&text[0..2])?;
    let minutes = digits(&text[3..5])?;
    Some(hours * 3600 + minutes * 60)
}

fn to_millis(instant: OffsetDateTime) -> i64 {
    instant.unix_timestamp() * 1_000 + i64::from(instant.millisecond())
}

/// `sha256(category + "\n" + signature)`, first 16 hex characters.
pub fn evidence_fingerprint(category: &str, signature: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{category}\n{signature}").as_bytes());
    let digest = hasher.finalize();
    let hex = hex::encode(digest);
    hex[..16].to_string()
}

/// `tool-failure` identity: the tool name and the normalized first non-empty
/// line of its result text.
pub fn tool_failure_fingerprint(tool_name: &str, text: &str) -> String {
    evidence_fingerprint(
        "tool-failure",
        &format!("{tool_name}\n{}", normalize_session_line(text, None)),
    )
}

/// Collapses whitespace and replaces volatile tokens; deterministic.
pub fn normalize_session_line(text: &str, repo_dir: Option<&Path>) -> String {
    let mut value: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if let Some(repo_dir) = repo_dir {
        let resolved = resolve_path(repo_dir).to_string_lossy().into_owned();
        if !resolved.is_empty() {
            value = value.replace(&resolved, "<repo>");
        }
    }
    let uuid = uuid_regex();
    value = uuid.replace_all(&value, "<uuid>").into_owned();
    let timestamp = timestamp_regex();
    value = timestamp.replace_all(&value, "<timestamp>").into_owned();
    let hex = hex_regex();
    value = hex.replace_all(&value, "<hex>").into_owned();
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn uuid_regex() -> &'static regex::Regex {
    static VALUE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
            .expect("a uuid regex")
    });
    &VALUE
}

fn timestamp_regex() -> &'static regex::Regex {
    static VALUE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?")
            .expect("a timestamp regex")
    });
    &VALUE
}

fn hex_regex() -> &'static regex::Regex {
    static VALUE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)\b[0-9a-f]{7,}\b").expect("a hex regex")
    });
    &VALUE
}

fn take_chars(text: &str, count: usize) -> String {
    text.chars().take(count).collect()
}

fn text_parts(content: Option<&Value>) -> String {
    let Some(content) = content else {
        return String::new();
    };
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    let Some(parts) = content.as_array() else {
        return String::new();
    };
    let mut texts: Vec<&str> = Vec::new();
    for part in parts {
        let Some(part) = part.as_object() else {
            continue;
        };
        if part.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(text) = part.get("text").and_then(Value::as_str) {
                texts.push(text);
            }
        }
    }
    texts.join("\n")
}

fn non_negative(value: Option<&Value>) -> f64 {
    match value.and_then(Value::as_f64) {
        Some(value) if value.is_finite() && value >= 0.0 => value,
        _ => 0.0,
    }
}

#[derive(Clone)]
struct Usage {
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
    total_tokens: f64,
    cost: f64,
}

impl Usage {
    fn empty() -> Self {
        Self {
            input: 0.0,
            output: 0.0,
            cache_read: 0.0,
            cache_write: 0.0,
            total_tokens: 0.0,
            cost: 0.0,
        }
    }

    fn add(&mut self, source: &Usage) {
        self.input += source.input;
        self.output += source.output;
        self.cache_read += source.cache_read;
        self.cache_write += source.cache_write;
        self.total_tokens += source.total_tokens;
        self.cost += source.cost;
    }

    fn to_json(&self) -> Value {
        json!({
            "input": number_json(self.input),
            "output": number_json(self.output),
            "cacheRead": number_json(self.cache_read),
            "cacheWrite": number_json(self.cache_write),
            "totalTokens": number_json(self.total_tokens),
            "cost": number_json(self.cost),
        })
    }
}

struct ParsedUsage {
    usage: Usage,
    cost: f64,
}

fn parse_usage(value: Option<&Value>) -> ParsedUsage {
    let Some(record) = value.and_then(Value::as_object) else {
        return ParsedUsage {
            usage: Usage::empty(),
            cost: 0.0,
        };
    };
    let cost_record = record
        .get("cost")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let input = non_negative(record.get("input"));
    let output = non_negative(record.get("output"));
    let cache_read = non_negative(record.get("cacheRead"));
    let cache_write = non_negative(record.get("cacheWrite"));
    let explicit_total = non_negative(record.get("totalTokens"));
    let total_tokens = if explicit_total > 0.0 {
        explicit_total
    } else {
        input + output + cache_read + cache_write
    };
    let explicit_cost = non_negative(cost_record.get("total"));
    let cost = if explicit_cost > 0.0 {
        explicit_cost
    } else {
        non_negative(cost_record.get("input"))
            + non_negative(cost_record.get("output"))
            + non_negative(cost_record.get("cacheRead"))
            + non_negative(cost_record.get("cacheWrite"))
    };
    ParsedUsage {
        usage: Usage {
            input,
            output,
            cache_read,
            cache_write,
            total_tokens,
            cost,
        },
        cost,
    }
}

/// Numbers render as JS numbers: an integer cost is `0`, not `0.0`.
fn number_json(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        Value::from(value as i64)
    } else {
        Value::from(value)
    }
}

fn first_user_line(records: &[Value]) -> String {
    for value in records {
        let Some(record) = value.as_object() else {
            continue;
        };
        if record.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let Some(message) = record.get("message").and_then(Value::as_object) else {
            continue;
        };
        if message.get("role").and_then(Value::as_str) != Some("user") {
            continue;
        }
        let text = text_parts(message.get("content"));
        if let Some(line) = text
            .split('\n')
            .map(str::trim)
            .find(|line| !line.is_empty())
        {
            return take_chars(line, 120);
        }
    }
    String::new()
}

#[derive(Clone)]
struct ParsedSession {
    session: Option<Value>,
    malformed: usize,
}

struct SessionMessage {
    index: usize,
    timestamp: Option<String>,
    role: String,
    text: String,
    tool_name: Option<String>,
    tool_call_id: Option<String>,
    is_error: bool,
    usage: Option<Usage>,
    error_fingerprint: Option<String>,
}

impl SessionMessage {
    fn to_json(&self) -> Value {
        json!({
            "index": self.index,
            "timestamp": self.timestamp,
            "role": self.role,
            "text": self.text,
            "toolName": self.tool_name,
            "toolCallId": self.tool_call_id,
            "isError": self.is_error,
            "usage": self.usage.as_ref().map(Usage::to_json),
            "errorFingerprint": self.error_fingerprint,
        })
    }
}

struct SessionToolCall {
    id: Option<String>,
    name: String,
    arguments_text: String,
    command: Option<String>,
    index: usize,
    timestamp: Option<String>,
}

impl SessionToolCall {
    fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "argumentsText": self.arguments_text,
            "command": self.command,
            "index": self.index,
            "timestamp": self.timestamp,
        })
    }
}

struct SessionToolResult {
    tool_call_id: Option<String>,
    tool_name: String,
    text: String,
    is_error: bool,
    index: usize,
    timestamp: Option<String>,
}

impl SessionToolResult {
    fn to_json(&self) -> Value {
        json!({
            "toolCallId": self.tool_call_id,
            "toolName": self.tool_name,
            "text": self.text,
            "isError": self.is_error,
            "index": self.index,
            "timestamp": self.timestamp,
        })
    }
}

/// Parses one transcript. The result carries the parsed session when a usable
/// `session` record exists; malformed lines are counted even then.
fn parse_session_transcript(
    text: &str,
    path: &Path,
    state_dir: &Path,
    repo_dir: &Path,
) -> ParsedSession {
    let mut records: Vec<Value> = Vec::new();
    let mut malformed = 0;
    for line in text.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(line) {
            Ok(value) if value.is_object() => records.push(value),
            _ => malformed += 1,
        }
    }

    let mut session_id: Option<String> = None;
    let mut session_started: Option<String> = None;
    let mut session_cwd: Option<String> = None;
    let mut title = String::new();
    for record in &records {
        let Some(record) = record.as_object() else {
            continue;
        };
        if record.get("type").and_then(Value::as_str) == Some("session") && session_id.is_none() {
            if let Some(id) = record.get("id").and_then(Value::as_str) {
                if !id.is_empty() {
                    session_id = Some(id.to_string());
                }
            }
            if let Some(cwd) = record.get("cwd").and_then(Value::as_str) {
                if !cwd.is_empty() {
                    session_cwd = Some(cwd.to_string());
                }
            }
            if let Some(instant) =
                parse_session_instant(record.get("timestamp").unwrap_or(&Value::Null))
            {
                session_started = Some(iso_from_millis(instant));
            }
            continue;
        }
        if record.get("type").and_then(Value::as_str) == Some("title") {
            if let Some(value) = record.get("title").and_then(Value::as_str) {
                let trimmed = value.trim();
                if !trimmed.is_empty() {
                    title = take_chars(trimmed, 200);
                }
            }
        }
    }

    let (Some(session_id), Some(session_started), Some(session_cwd)) =
        (session_id, session_started, session_cwd)
    else {
        return ParsedSession {
            session: None,
            malformed,
        };
    };

    let absolute_cwd = resolve_path(Path::new(&session_cwd));
    let absolute_repo = resolve_path(repo_dir);
    let relative_cwd = relative(&absolute_repo, &absolute_cwd)
        .map(|local| {
            if local.is_empty() {
                ".".to_string()
            } else if local.starts_with("..") {
                absolute_cwd.to_string_lossy().into_owned()
            } else {
                local
            }
        })
        .unwrap_or_else(|| absolute_cwd.to_string_lossy().into_owned());

    let mut messages: Vec<SessionMessage> = Vec::new();
    let mut calls: Vec<SessionToolCall> = Vec::new();
    let mut results: Vec<SessionToolResult> = Vec::new();
    let mut usage = Usage::empty();
    let mut cost = 0.0;
    let mut index = 0usize;

    for record in &records {
        let Some(record) = record.as_object() else {
            continue;
        };
        if record.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let Some(message) = record.get("message").and_then(Value::as_object) else {
            continue;
        };
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("other")
            .to_string();
        let timestamp = record
            .get("timestamp")
            .and_then(Value::as_str)
            .filter(|value| parse_instant_text(value).is_some())
            .map(|value| iso_from_millis(parse_instant_text(value).unwrap_or(0)));
        let content = message.get("content");
        let parts: &[Value] = content
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);

        if role == "assistant" {
            let parsed = parse_usage(message.get("usage"));
            usage.add(&parsed.usage);
            cost += parsed.cost;
        }

        if role == "toolResult" {
            let tool_name = message
                .get("toolName")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            let result_text = take_chars(
                &text_parts(content),
                SESSION_MESSAGE_TEXT_MAX.saturating_mul(4),
            );
            let is_error = message.get("isError").and_then(Value::as_bool) == Some(true);
            let tool_call_id = message
                .get("toolCallId")
                .and_then(Value::as_str)
                .map(str::to_string);
            results.push(SessionToolResult {
                tool_call_id: tool_call_id.clone(),
                tool_name: tool_name.clone(),
                text: result_text.clone(),
                is_error,
                index,
                timestamp: timestamp.clone(),
            });
            messages.push(SessionMessage {
                index,
                timestamp,
                role,
                text: result_text.clone(),
                tool_name: Some(tool_name.clone()),
                tool_call_id,
                is_error,
                usage: None,
                error_fingerprint: is_error
                    .then(|| tool_failure_fingerprint(&tool_name, &result_text)),
            });
            index += 1;
            continue;
        }

        let text = text_parts(content);
        let normalized_text = take_chars(&text, SESSION_MESSAGE_TEXT_MAX);
        let message_usage = if role == "assistant" {
            Some(parse_usage(message.get("usage")).usage)
        } else {
            None
        };
        let mut emitted = false;
        for part in parts {
            let Some(part) = part.as_object() else {
                continue;
            };
            if part.get("type").and_then(Value::as_str) != Some("toolCall") {
                continue;
            }
            let name = part
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            let id = part.get("id").and_then(Value::as_str).map(str::to_string);
            let arguments = part.get("arguments").and_then(Value::as_object).cloned();
            let arguments_value = arguments
                .clone()
                .map(Value::Object)
                .unwrap_or_else(|| Value::Object(Map::new()));
            let arguments_text = normalize_session_line(
                &crate::jsjson::stringify(&arguments_value),
                Some(&absolute_repo),
            );
            let command = arguments
                .as_ref()
                .and_then(|record| record.get("command"))
                .and_then(Value::as_str)
                .map(str::to_string);
            calls.push(SessionToolCall {
                id: id.clone(),
                name: name.clone(),
                arguments_text,
                command,
                index,
                timestamp: timestamp.clone(),
            });
            messages.push(SessionMessage {
                index,
                timestamp: timestamp.clone(),
                role: role.clone(),
                text: normalized_text.clone(),
                tool_name: Some(name),
                tool_call_id: id,
                is_error: false,
                usage: message_usage.clone(),
                error_fingerprint: None,
            });
            index += 1;
            emitted = true;
        }
        if !emitted && (!text.is_empty() || role != "assistant") {
            messages.push(SessionMessage {
                index,
                timestamp,
                role,
                text: normalized_text,
                tool_name: None,
                tool_call_id: None,
                is_error: false,
                usage: message_usage,
                error_fingerprint: None,
            });
            index += 1;
        }
    }

    let relative_path = relative(&resolve_path(state_dir), &resolve_path(path))
        .unwrap_or_else(|| resolve_path(path).to_string_lossy().into_owned());
    let tool_error_count = results.iter().filter(|result| result.is_error).count();
    let message_json: Vec<Value> = messages.iter().map(SessionMessage::to_json).collect();
    let call_json: Vec<Value> = calls.iter().map(SessionToolCall::to_json).collect();
    let result_json: Vec<Value> = results.iter().map(SessionToolResult::to_json).collect();
    let effective_title = if title.is_empty() {
        first_user_line(&records)
    } else {
        title
    };
    let session = json!({
        "id": session_id,
        "path": resolve_path(path).to_string_lossy().into_owned(),
        "relativePath": relative_path,
        "startedAt": session_started,
        "title": effective_title,
        "cwd": absolute_cwd.to_string_lossy().into_owned(),
        "relativeCwd": relative_cwd,
        "messages": message_json,
        "calls": call_json,
        "results": result_json,
        "usage": usage.to_json(),
        "cost": number_json(cost),
        "messageCount": messages.len(),
        "toolErrorCount": tool_error_count,
        "malformed": malformed,
    });
    ParsedSession {
        session: Some(session),
        malformed,
    }
}

// ---------------------------------------------------------------------------
// Transcript discovery
// ---------------------------------------------------------------------------

/// One transcript file with the metadata a selection needs before parsing.
#[derive(Clone)]
struct SessionFileMeta {
    path: PathBuf,
    mtime_ms: i64,
}

#[derive(Clone)]
struct SessionHeader {
    id: String,
    cwd: String,
    started_at: String,
}

/// How often this process parsed a header or a transcript. A repeat read of an
/// unchanged file changes neither count.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SessionCacheStats {
    pub headers_parsed: u64,
    pub transcripts_parsed: u64,
}

#[derive(Default)]
struct SessionCache {
    headers: std::collections::HashMap<PathBuf, (i64, Option<SessionHeader>)>,
    transcripts: std::collections::HashMap<PathBuf, (i64, ParsedSession)>,
    stats: SessionCacheStats,
}

fn session_cache() -> &'static std::sync::Mutex<SessionCache> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<SessionCache>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(SessionCache::default()))
}

/// The parse counters, for a test that proves an unchanged transcript is not
/// read twice.
pub fn session_cache_stats() -> SessionCacheStats {
    session_cache()
        .lock()
        .map(|cache| cache.stats)
        .unwrap_or_default()
}

/// Empties the cache and its counters.
pub fn reset_session_cache() {
    if let Ok(mut cache) = session_cache().lock() {
        *cache = SessionCache::default();
    }
}

fn byte_order(left: &str, right: &str) -> std::cmp::Ordering {
    left.cmp(right)
}

/// Every `.jsonl` transcript under the providers agent tree, with metadata.
fn list_session_files(state_dir: &Path) -> Vec<SessionFileMeta> {
    let root = resolve_path(state_dir).join("providers").join("agents");
    let mut files: Vec<SessionFileMeta> = Vec::new();
    let mut agents: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                agents.push(entry.path());
            }
        }
    }
    agents.sort_by(|left, right| byte_order(&left.to_string_lossy(), &right.to_string_lossy()));
    fn walk(directory: &Path, files: &mut Vec<SessionFileMeta>) {
        let Ok(entries) = std::fs::read_dir(directory) else {
            return;
        };
        let mut ordered: Vec<std::fs::DirEntry> = entries.flatten().collect();
        ordered.sort_by(|left, right| {
            byte_order(
                &left.file_name().to_string_lossy(),
                &right.file_name().to_string_lossy(),
            )
        });
        for entry in ordered {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                walk(&path, files);
            } else if kind.is_file()
                && path
                    .extension()
                    .map(|value| value == "jsonl")
                    .unwrap_or(false)
            {
                if let Ok(metadata) = entry.metadata() {
                    files.push(SessionFileMeta {
                        path,
                        mtime_ms: mtime_millis(&metadata),
                    });
                }
            }
        }
    }
    for agent in agents {
        walk(&agent.join("sessions"), &mut files);
    }
    files.sort_by(|left, right| {
        byte_order(&left.path.to_string_lossy(), &right.path.to_string_lossy())
    });
    files
}

fn mtime_millis(metadata: &std::fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn parse_session_header_text(text: &str) -> Option<SessionHeader> {
    for line in text.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(record) = value.as_object() else {
            continue;
        };
        if record.get("type").and_then(Value::as_str) != Some("session") {
            continue;
        }
        let id = record
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())?;
        let cwd = record
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|cwd| !cwd.is_empty())?;
        let instant = parse_session_instant(record.get("timestamp").unwrap_or(&Value::Null))?;
        return Some(SessionHeader {
            id: id.to_string(),
            cwd: cwd.to_string(),
            started_at: iso_from_millis(instant),
        });
    }
    None
}

fn read_header(meta: &SessionFileMeta) -> Option<SessionHeader> {
    use std::io::Read;
    if let Ok(cache) = session_cache().lock() {
        if let Some((mtime, header)) = cache.headers.get(&meta.path) {
            if *mtime == meta.mtime_ms {
                return header.clone();
            }
        }
    }
    let mut file = std::fs::File::open(&meta.path).ok()?;
    let mut buffer = vec![0u8; HEADER_SCAN_BYTES as usize];
    let read = file.read(&mut buffer).ok()?;
    let text = String::from_utf8_lossy(&buffer[..read]);
    let header = parse_session_header_text(&text);
    if let Ok(mut cache) = session_cache().lock() {
        cache
            .headers
            .insert(meta.path.clone(), (meta.mtime_ms, header.clone()));
        cache.stats.headers_parsed += 1;
    }
    header
}

fn read_transcript(meta: &SessionFileMeta, state_dir: &Path, repo_dir: &Path) -> ParsedSession {
    if let Ok(cache) = session_cache().lock() {
        if let Some((mtime, parsed)) = cache.transcripts.get(&meta.path) {
            if *mtime == meta.mtime_ms {
                return parsed.clone();
            }
        }
    }
    let parsed = match std::fs::read_to_string(&meta.path) {
        Ok(text) => parse_session_transcript(&text, &meta.path, state_dir, repo_dir),
        Err(_) => ParsedSession {
            session: None,
            malformed: 0,
        },
    };
    if let Ok(mut cache) = session_cache().lock() {
        cache
            .transcripts
            .insert(meta.path.clone(), (meta.mtime_ms, parsed.clone()));
        cache.stats.transcripts_parsed += 1;
    }
    parsed
}

struct SelectedTranscript {
    meta: SessionFileMeta,
    header: SessionHeader,
}

struct TranscriptHeaders {
    ordered: Vec<SelectedTranscript>,
    skipped: usize,
}

fn transcript_headers(
    state_dir: &Path,
    repo_dir: &Path,
    mtime_since: Option<i64>,
) -> TranscriptHeaders {
    let state_dir = resolve_path(state_dir);
    let repo_dir = resolve_path(repo_dir);
    let mut skipped = 0;
    let mut by_id: std::collections::HashMap<String, SelectedTranscript> =
        std::collections::HashMap::new();
    for meta in list_session_files(&state_dir) {
        if let Some(since) = mtime_since {
            if meta.mtime_ms < since {
                continue;
            }
        }
        let Some(header) = read_header(&meta) else {
            skipped += 1;
            continue;
        };
        if !is_repository_working_directory(&repo_dir, &header.cwd) {
            continue;
        }
        let replace = match by_id.get(&header.id) {
            None => true,
            Some(existing) => {
                header.started_at > existing.header.started_at
                    || (header.started_at == existing.header.started_at
                        && meta.path.to_string_lossy() > existing.meta.path.to_string_lossy())
            }
        };
        if replace {
            by_id.insert(header.id.clone(), SelectedTranscript { meta, header });
        }
    }
    let mut ordered: Vec<SelectedTranscript> = by_id.into_values().collect();
    ordered.sort_by(|left, right| {
        right
            .header
            .started_at
            .cmp(&left.header.started_at)
            .then_with(|| {
                byte_order(
                    &left.meta.path.to_string_lossy(),
                    &right.meta.path.to_string_lossy(),
                )
            })
    });
    TranscriptHeaders { ordered, skipped }
}

struct ParsedSelection {
    sessions: Vec<Value>,
    skipped: usize,
    malformed: usize,
}

fn parse_transcripts(
    entries: &[SelectedTranscript],
    state_dir: &Path,
    repo_dir: &Path,
) -> ParsedSelection {
    let mut sessions = Vec::new();
    let mut skipped = 0;
    let mut malformed = 0;
    for entry in entries {
        let parsed = read_transcript(&entry.meta, state_dir, repo_dir);
        malformed += parsed.malformed;
        match parsed.session {
            Some(session) => sessions.push(session),
            None => skipped += 1,
        }
    }
    ParsedSelection {
        sessions,
        skipped,
        malformed,
    }
}

struct SessionSelection {
    sessions: Vec<Value>,
    selected: usize,
}

fn select_sessions(
    state_dir: &Path,
    repo_dir: &Path,
    max_files: usize,
    skip: usize,
    filter: Option<&dyn Fn(&SessionHeader) -> bool>,
    mtime_since: Option<i64>,
) -> SessionSelection {
    let max_files = max_files.max(1);
    let headers = transcript_headers(state_dir, repo_dir, mtime_since);
    let matching: Vec<&SelectedTranscript> = match filter {
        None => headers.ordered.iter().collect(),
        Some(filter) => headers
            .ordered
            .iter()
            .filter(|entry| filter(&entry.header))
            .collect(),
    };
    let kept: Vec<SelectedTranscript> = matching
        .iter()
        .skip(skip)
        .take(max_files)
        .map(|entry| SelectedTranscript {
            meta: entry.meta.clone(),
            header: entry.header.clone(),
        })
        .collect();
    let parsed = parse_transcripts(&kept, state_dir, repo_dir);
    let mut sessions = parsed.sessions;
    sessions.sort_by(|left, right| {
        let left_started = left
            .get("startedAt")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let right_started = right
            .get("startedAt")
            .and_then(Value::as_str)
            .unwrap_or_default();
        left_started.cmp(right_started).then_with(|| {
            let left_path = left.get("path").and_then(Value::as_str).unwrap_or_default();
            let right_path = right
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default();
            left_path.cmp(right_path)
        })
    });
    let _ = (headers.skipped, parsed.skipped, parsed.malformed);
    SessionSelection {
        selected: matching.len(),
        sessions,
    }
}

fn summary(session: &Value) -> Value {
    let usage = session.get("usage").cloned().unwrap_or(Value::Null);
    let token = |key: &str| usage.get(key).cloned().unwrap_or(json!(0));
    json!({
        "id": session.get("id").cloned().unwrap_or(Value::Null),
        "relativePath": session.get("relativePath").cloned().unwrap_or(Value::Null),
        "startedAt": session.get("startedAt").cloned().unwrap_or(Value::Null),
        "title": session.get("title").cloned().unwrap_or(Value::Null),
        "relativeCwd": session.get("relativeCwd").cloned().unwrap_or(Value::Null),
        "messageCount": session.get("messageCount").cloned().unwrap_or(json!(0)),
        "toolErrorCount": session.get("toolErrorCount").cloned().unwrap_or(json!(0)),
        "tokens": {
            "input": token("input"),
            "output": token("output"),
            "cacheRead": token("cacheRead"),
            "cacheWrite": token("cacheWrite"),
            "total": token("totalTokens"),
        },
        "cost": session.get("cost").cloned().unwrap_or(json!(0)),
    })
}

/// The MCP listing: newest first, bounded. `since` and `until` bound the session
/// start; `cwd` matches the recorded working directory after resolution.
pub fn list_sessions(options: &ListSessionsOptions) -> Value {
    let limit = options
        .limit
        .unwrap_or(SESSION_LIST_DEFAULT_LIMIT)
        .clamp(1, SESSION_LIST_MAX_LIMIT);
    let offset = options.offset.unwrap_or(0);
    let since = options.since.as_deref().and_then(parse_instant_text);
    let until = options.until.as_deref().and_then(parse_instant_text);
    let cwd = options
        .cwd
        .as_deref()
        .filter(|cwd| !cwd.is_empty())
        .map(|cwd| resolve_path(&resolve_path(&options.repo_dir).join(cwd)));
    let filter = if since.is_none() && until.is_none() && cwd.is_none() {
        None
    } else {
        Some(move |header: &SessionHeader| {
            let Some(started) = parse_instant_text(&header.started_at) else {
                return false;
            };
            if let Some(since) = since {
                if started < since {
                    return false;
                }
            }
            if let Some(until) = until {
                if started > until {
                    return false;
                }
            }
            if let Some(cwd) = cwd.as_ref() {
                if &resolve_path(Path::new(&header.cwd)) != cwd {
                    return false;
                }
            }
            true
        })
    };
    let selection = select_sessions(
        &options.state_dir,
        &options.repo_dir,
        options.max_files.unwrap_or(SESSION_MAX_FILES),
        offset,
        filter
            .as_ref()
            .map(|filter| filter as &dyn Fn(&SessionHeader) -> bool),
        options.mtime_since,
    );
    let mut rows: Vec<Value> = selection.sessions.iter().map(summary).collect();
    rows.sort_by(|left, right| {
        let left_started = left
            .get("startedAt")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let right_started = right
            .get("startedAt")
            .and_then(Value::as_str)
            .unwrap_or_default();
        right_started.cmp(left_started).then_with(|| {
            let left_path = left
                .get("relativePath")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let right_path = right
                .get("relativePath")
                .and_then(Value::as_str)
                .unwrap_or_default();
            left_path.cmp(right_path)
        })
    });
    let page: Vec<Value> = rows.into_iter().take(limit).collect();
    let next = offset + page.len();
    let truncated = next < selection.selected;
    json!({
        "sessions": page,
        "total": selection.selected,
        "truncated": truncated,
        "nextOffset": if truncated { Some(next) } else { None },
    })
}

pub struct ListSessionsOptions {
    pub state_dir: PathBuf,
    pub repo_dir: PathBuf,
    pub since: Option<String>,
    pub until: Option<String>,
    pub cwd: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
    pub max_files: Option<usize>,
    pub mtime_since: Option<i64>,
}

/// One session's messages in index order, bounded by rows and bytes.
pub fn read_session_messages(
    state_dir: &Path,
    repo_dir: &Path,
    id: &str,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Option<Value> {
    let state_dir = resolve_path(state_dir);
    let repo_dir = resolve_path(repo_dir);
    let mut matched: Option<SelectedTranscript> = None;
    for meta in list_session_files(&state_dir) {
        let Some(header) = read_header(&meta) else {
            continue;
        };
        if header.id != id {
            continue;
        }
        if !is_repository_working_directory(&repo_dir, &header.cwd) {
            continue;
        }
        let replace = match matched.as_ref() {
            None => true,
            Some(existing) => {
                header.started_at > existing.header.started_at
                    || (header.started_at == existing.header.started_at
                        && meta.path.to_string_lossy() > existing.meta.path.to_string_lossy())
            }
        };
        if replace {
            matched = Some(SelectedTranscript { meta, header });
        }
    }
    let matched = matched?;
    let parsed = read_transcript(&matched.meta, &state_dir, &repo_dir);
    let session = parsed.session?;
    let limit = limit
        .unwrap_or(SESSION_READ_DEFAULT_LIMIT)
        .clamp(1, SESSION_READ_MAX_LIMIT);
    let offset = offset.unwrap_or(0);
    let all_messages = session
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut messages: Vec<Value> = Vec::new();
    let mut bytes = 0usize;
    let mut cursor = offset;
    while cursor < all_messages.len() && messages.len() < limit {
        let message = &all_messages[cursor];
        let cost = crate::jsjson::stringify(message).len();
        if !messages.is_empty() && bytes + cost > SESSION_RESPONSE_MAX_BYTES {
            break;
        }
        bytes += cost;
        messages.push(message.clone());
        cursor += 1;
    }
    let truncated = cursor < all_messages.len();
    Some(json!({
        "id": session.get("id").cloned().unwrap_or(Value::Null),
        "messages": messages,
        "total": all_messages.len(),
        "truncated": truncated,
        "nextOffset": if truncated { Some(cursor) } else { None },
        "malformed": parsed.malformed,
    }))
}

/// Case-insensitive substring matches across message text, newest session first.
pub fn search_sessions(
    state_dir: &Path,
    repo_dir: &Path,
    query: &str,
    limit: Option<usize>,
    max_files: Option<usize>,
) -> Value {
    let needle = query.to_lowercase();
    let cap = limit
        .unwrap_or(SESSION_SEARCH_MAX_MATCHES)
        .clamp(1, SESSION_SEARCH_MAX_MATCHES);
    let max_files = max_files.unwrap_or(SESSION_MAX_FILES).max(1);
    let headers = transcript_headers(state_dir, repo_dir, None);
    let mut matches: Vec<Value> = Vec::new();
    let mut start = 0usize;
    while start < headers.ordered.len() {
        let end = (start + max_files).min(headers.ordered.len());
        let mut parsed = parse_transcripts(&headers.ordered[start..end], state_dir, repo_dir);
        parsed.sessions.sort_by(|left, right| {
            let left_started = left
                .get("startedAt")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let right_started = right
                .get("startedAt")
                .and_then(Value::as_str)
                .unwrap_or_default();
            right_started.cmp(left_started).then_with(|| {
                let left_path = left.get("path").and_then(Value::as_str).unwrap_or_default();
                let right_path = right
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                left_path.cmp(right_path)
            })
        });
        for session in parsed.sessions {
            let session_id = session
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let messages = session
                .get("messages")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for message in messages {
                let text = message
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let lower = text.to_lowercase();
                let Some(at) = lower.find(&needle) else {
                    continue;
                };
                let at_chars = lower[..at].chars().count();
                let snippet_start = at_chars.saturating_sub(60);
                let snippet: String = text
                    .chars()
                    .skip(snippet_start)
                    .take(SESSION_SEARCH_SNIPPET_MAX)
                    .collect();
                let snippet = snippet.split_whitespace().collect::<Vec<_>>().join(" ");
                let snippet = take_chars(snippet.trim(), SESSION_SEARCH_SNIPPET_MAX);
                matches.push(json!({
                    "sessionId": session_id,
                    "index": message.get("index").cloned().unwrap_or(json!(0)),
                    "role": message.get("role").cloned().unwrap_or(Value::Null),
                    "snippet": snippet,
                }));
                if matches.len() > cap {
                    matches.truncate(cap);
                    return json!({"matches": matches, "truncated": true});
                }
            }
        }
        start = end;
    }
    json!({"matches": matches, "truncated": false})
}

/// True when the cwd is the repository root or inside its `.worktree/`.
pub fn is_repository_working_directory(repo_dir: &Path, cwd: &str) -> bool {
    let root = resolve_path(repo_dir);
    let target = resolve_path(Path::new(cwd));
    if target == root {
        return true;
    }
    target.starts_with(root.join(".worktree"))
}

/// Resolves one path the way `path.resolve` does: against the working
/// directory, lexically, without touching the filesystem.
pub fn resolve_path(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    normalize(&absolute)
}

fn normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                let remove = matches!(
                    normalized.components().next_back(),
                    Some(Component::Normal(_))
                );
                if remove {
                    normalized.pop();
                    continue;
                }
                let keep = matches!(
                    normalized.components().next_back(),
                    Some(Component::RootDir) | Some(Component::Prefix(_))
                );
                if !keep {
                    normalized.push("..");
                }
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

/// `path.relative(root, target)` with `/`-separated components.
fn relative(root: &Path, target: &Path) -> Option<String> {
    let root_components: Vec<Component> = root.components().collect();
    let target_components: Vec<Component> = target.components().collect();
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
    Some(parts.join("/"))
}
