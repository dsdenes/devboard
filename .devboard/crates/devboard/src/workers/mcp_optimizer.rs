//! The MCP optimizer worker: the deterministic family pipeline, the ACP
//! synthesis turn per selected family, the ledger and cycle report, and the
//! detached worker that owns one harness version's lock and cadence.
//!
//! One instance serves one repository state directory, so the dashboard's
//! `STATE_DIR` is the only anchor: the worker, its settings, control channel,
//! ledger, lock, runs, and forge projection all live under `<STATE_DIR>/coach/`.
//! The legacy worker state, control, and lock sit directly there; every newer
//! harness version gets its own directory and lock beside them, so two versions
//! can hand off without either reading the other's state. The directory keeps
//! its historical `coach/` name on purpose: a harness upgrade can leave a
//! worker of the previous version live on the same lock, control channel, and
//! ledger, and moving the state would strand that worker.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::future::Future;
use std::io::Write as _;
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Number, Value};
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, UtcOffset};

use super::WorkerInvocation;

// ---------------------------------------------------------------------------
// Paths

/// The historical directory name; never renamed.
pub const MCP_OPTIMIZER_DIRECTORY: &str = "coach";
pub const WORKERS_DIRECTORY: &str = "workers";
pub const WORKER_VERSION: u64 = 1;
pub const LEDGER_VERSION: u64 = 3;
pub const PROJECTION_VERSION: u64 = 1;

pub fn mcp_optimizer_directory(state_dir: &Path) -> PathBuf {
    resolve(state_dir).join(MCP_OPTIMIZER_DIRECTORY)
}

pub fn worker_state_path(directory: &Path) -> PathBuf {
    directory.join("worker.json")
}

/// One harness version's directory beside the legacy layout:
/// `<mcpOptimizerDir>/workers/<versionKey>/{worker.json,control}`.
pub fn versioned_worker_directory(directory: &Path, version: Option<&str>) -> PathBuf {
    directory
        .join(WORKERS_DIRECTORY)
        .join(worker_version_key(version))
}

pub fn versioned_control_directory(directory: &Path, version: Option<&str>) -> PathBuf {
    versioned_worker_directory(directory, version).join("control")
}

/// Every version's worker directory under one MCP optimizer directory.
pub fn worker_state_directories(directory: &Path) -> Vec<PathBuf> {
    let root = directory.join(WORKERS_DIRECTORY);
    let mut paths: Vec<PathBuf> = std::fs::read_dir(&root)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
                .map(|entry| root.join(entry.file_name()))
                .collect()
        })
        .unwrap_or_default();
    paths.sort();
    paths
}

/// The cycle lease: one MCP optimizer cycle at a time across every harness
/// version. Held only while a cycle runs.
pub fn cycle_lock_path(directory: &Path) -> PathBuf {
    directory.join("cycle.lock")
}

pub fn settings_path(directory: &Path) -> PathBuf {
    directory.join("settings.json")
}

pub fn control_directory(directory: &Path) -> PathBuf {
    directory.join("control")
}

/// The ledger: one entry per family plus the pending queue.
pub fn ledger_path(directory: &Path) -> PathBuf {
    directory.join("state.json")
}

pub fn lock_path(directory: &Path) -> PathBuf {
    directory.join("lock")
}

/// A version's own worker lock beside the legacy lock.
pub fn versioned_lock_path(directory: &Path, version: Option<&str>) -> PathBuf {
    version_lock_path(&lock_path(directory), version)
}

pub fn runs_directory(directory: &Path) -> PathBuf {
    directory.join("runs")
}

pub fn latest_path(directory: &Path) -> PathBuf {
    directory.join("latest.json")
}

pub fn projection_path(directory: &Path) -> PathBuf {
    directory.join("projection.json")
}

/// A version-safe segment for a lock file or worker directory.
pub fn worker_version_key(version: Option<&str>) -> String {
    let text = match version {
        Some(value) if !value.is_empty() => value,
        _ => "unknown",
    };
    text.chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

/// A version's own lock beside a legacy lock path.
pub fn version_lock_path(base: &Path, version: Option<&str>) -> PathBuf {
    PathBuf::from(format!(
        "{}.{}",
        base.display(),
        worker_version_key(version)
    ))
}

// ---------------------------------------------------------------------------
// Time

fn iso_format() -> &'static [time::format_description::BorrowedFormatItem<'static>] {
    *FORMAT
}

static FORMAT: std::sync::LazyLock<
    &'static [time::format_description::BorrowedFormatItem<'static>],
> = std::sync::LazyLock::new(|| {
    time::macros::format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
    )
});

/// The exact text JavaScript's `Date#toISOString` writes.
pub fn iso(instant: OffsetDateTime) -> String {
    instant
        .to_offset(UtcOffset::UTC)
        .format(iso_format())
        .unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".to_string())
}

pub fn now_iso() -> String {
    iso(OffsetDateTime::now_utc())
}

pub fn now_millis() -> i64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as i128)
        .unwrap_or(0);
    (nanos / 1_000_000) as i64
}

pub fn epoch_millis(instant: OffsetDateTime) -> i64 {
    (instant.unix_timestamp_nanos() / 1_000_000) as i64
}

pub fn from_millis(millis: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH)
}

/// Parses the instants transcripts, journals, and settings carry. A value
/// without a timezone is read as UTC, like `Date.parse`.
pub fn parse_instant(value: &str) -> Option<OffsetDateTime> {
    let trimmed = value.trim();
    if trimmed.len() < 10 || !trimmed.is_ascii() {
        return None;
    }
    let bytes = trimmed.as_bytes();
    if bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let year: i32 = trimmed.get(0..4)?.parse().ok()?;
    let month = time::Month::try_from(trimmed.get(5..7)?.parse::<u8>().ok()?).ok()?;
    let day: u8 = trimmed.get(8..10)?.parse().ok()?;
    let date = time::Date::from_calendar_date(year, month, day).ok()?;
    if trimmed.len() == 10 {
        return Some(date.midnight().assume_utc());
    }
    if trimmed.len() < 19 || bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }
    let hour: u8 = trimmed.get(11..13)?.parse().ok()?;
    let minute: u8 = trimmed.get(14..16)?.parse().ok()?;
    let second: u8 = trimmed.get(17..19)?.parse().ok()?;
    let mut rest = &trimmed[19..];
    let mut millis: u16 = 0;
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits: String = fraction.chars().take_while(char::is_ascii_digit).collect();
        rest = &fraction[digits.len()..];
        let mut padded = digits;
        while padded.len() < 3 {
            padded.push('0');
        }
        millis = padded.get(0..3)?.parse().ok()?;
    }
    let offset = if rest.is_empty() || rest == "Z" || rest == "z" {
        UtcOffset::UTC
    } else if rest.len() == 6 && (rest.starts_with('+') || rest.starts_with('-')) {
        let sign = if rest.starts_with('-') { -1 } else { 1 };
        let hours: i8 = rest.get(1..3)?.parse().ok()?;
        let minutes: i8 = rest.get(4..6)?.parse().ok()?;
        UtcOffset::from_hms(sign * hours, sign * minutes, 0).ok()?
    } else if rest.len() == 5 && (rest.starts_with('+') || rest.starts_with('-')) {
        let sign = if rest.starts_with('-') { -1 } else { 1 };
        let hours: i8 = rest.get(1..3)?.parse().ok()?;
        let minutes: i8 = rest.get(3..5)?.parse().ok()?;
        UtcOffset::from_hms(sign * hours, sign * minutes, 0).ok()?
    } else {
        return None;
    };
    let clock = time::Time::from_hms_milli(hour, minute, second, millis).ok()?;
    Some(time::PrimitiveDateTime::new(date, clock).assume_offset(offset))
}

pub fn parse_instant_millis(value: &str) -> Option<i64> {
    parse_instant(value).map(epoch_millis)
}

/// `now.toISOString().replace(/[:.]/g, "-")`, the run directory name.
fn stamp(instant: OffsetDateTime) -> String {
    iso(instant).replace([':', '.'], "-")
}

// ---------------------------------------------------------------------------
// JSON files

/// The exact text `writeJsonAtomic` writes: two-space indentation, a trailing
/// newline, and object keys in insertion order.
pub fn json_file_text(value: &Value) -> String {
    let mut text = serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".to_string());
    text.push('\n');
    text
}

/// `writeJsonAtomic`: a staged file renamed over the target.
pub fn write_json_atomic(path: &Path, value: &Value) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    let text = json_file_text(value);
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&temporary)?;
        file.write_all(text.as_bytes())?;
        drop(file);
        std::fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn read_json(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn record(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

/// A finite JavaScript number, formatted without a trailing `.0`.
fn number_value(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        Value::from(value as i64)
    } else {
        Number::from_f64(value)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}

fn number_field(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64().filter(|value| value.is_finite()),
        _ => None,
    }
}

fn optional_number_field(value: Option<&Value>) -> Option<f64> {
    value.and_then(number_field)
}

/// The first non-empty trimmed line of a diagnostic.
pub fn first_line(text: &str) -> String {
    text.split('\n')
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("no diagnostic")
        .to_string()
}

fn error_line(error: &anyhow::Error) -> String {
    first_line(&format!("{error:#}"))
}

// ---------------------------------------------------------------------------
// Settings

pub const DEFAULT_INTERVAL_MINUTES: u32 = 60;
pub const DEFAULT_MAX_PER_HOUR: Option<u32> = Some(10);
pub const DEFAULT_MAX_PENDING: Option<u32> = Some(20);
pub const DEFAULT_MAX_ISSUES_PER_CYCLE: u32 = 2;
pub const MAX_ALLOWLIST_ENTRIES: usize = 50;
pub const MAX_ALLOWLIST_ENTRY: usize = 200;

/// What the dashboard persists and the worker applies without a restart.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Settings {
    pub interval_minutes: u32,
    /// Filings per rolling hour; `None` is unlimited.
    pub max_per_hour: Option<u32>,
    /// Pending proposals kept; `None` is unlimited.
    pub max_pending: Option<u32>,
    /// Issues filed in one cycle, 1 through 20.
    pub max_issues_per_cycle: u32,
    /// Command prefixes a tool proposal must match to be filed.
    pub allowlist: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            interval_minutes: DEFAULT_INTERVAL_MINUTES,
            max_per_hour: DEFAULT_MAX_PER_HOUR,
            max_pending: DEFAULT_MAX_PENDING,
            max_issues_per_cycle: DEFAULT_MAX_ISSUES_PER_CYCLE,
            allowlist: Vec::new(),
        }
    }
}

impl Settings {
    pub fn to_json(&self) -> Value {
        json!({
            "intervalMinutes": self.interval_minutes,
            "maxPerHour": self.max_per_hour,
            "maxPending": self.max_pending,
            "maxIssuesPerCycle": self.max_issues_per_cycle,
            "allowlist": self.allowlist,
        })
    }
}

pub fn is_valid_cadence(value: Option<&Value>) -> bool {
    matches!(optional_number_field(value), Some(amount) if amount.fract() == 0.0 && (1.0..=1440.0).contains(&amount))
}

pub fn is_valid_limit(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Null) => true,
        Some(_) => {
            matches!(optional_number_field(value), Some(amount) if amount.fract() == 0.0 && (1.0..=100.0).contains(&amount))
        }
        None => false,
    }
}

pub fn is_valid_issues_per_cycle(value: Option<&Value>) -> bool {
    matches!(optional_number_field(value), Some(amount) if amount.fract() == 0.0 && (1.0..=20.0).contains(&amount))
}

pub fn is_valid_allowlist(value: Option<&Value>) -> bool {
    let Some(entries) = value.and_then(Value::as_array) else {
        return false;
    };
    entries.len() <= MAX_ALLOWLIST_ENTRIES
        && entries.iter().all(|entry| {
            entry
                .as_str()
                .map(|text| !text.trim().is_empty() && text.chars().count() <= MAX_ALLOWLIST_ENTRY)
                .unwrap_or(false)
        })
}

fn limit_of(value: Option<&Value>, fallback: Option<u32>) -> Option<u32> {
    if is_valid_limit(value) {
        match value {
            Some(Value::Null) => None,
            Some(other) => number_field(other).map(|amount| amount as u32),
            None => fallback,
        }
    } else {
        fallback
    }
}

/// Parses a settings file. A missing or unknown key falls back to its default
/// and never rejects the file; an invalid known key falls back on its own.
pub fn parse_settings(text: &str) -> Option<Settings> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    let record = record(&parsed)?;
    let interval_minutes = if is_valid_cadence(record.get("intervalMinutes")) {
        optional_number_field(record.get("intervalMinutes"))? as u32
    } else {
        DEFAULT_INTERVAL_MINUTES
    };
    let max_issues_per_cycle = if is_valid_issues_per_cycle(record.get("maxIssuesPerCycle")) {
        optional_number_field(record.get("maxIssuesPerCycle"))? as u32
    } else {
        DEFAULT_MAX_ISSUES_PER_CYCLE
    };
    let allowlist = if is_valid_allowlist(record.get("allowlist")) {
        record
            .get("allowlist")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    Some(Settings {
        interval_minutes,
        max_per_hour: limit_of(record.get("maxPerHour"), DEFAULT_MAX_PER_HOUR),
        max_pending: limit_of(record.get("maxPending"), DEFAULT_MAX_PENDING),
        max_issues_per_cycle,
        allowlist,
    })
}

pub fn read_settings(directory: &Path) -> Settings {
    std::fs::read_to_string(settings_path(directory))
        .ok()
        .and_then(|text| parse_settings(&text))
        .unwrap_or_default()
}

pub fn write_settings(directory: &Path, settings: &Settings) -> std::io::Result<()> {
    write_json_atomic(&settings_path(directory), &settings.to_json())
}

// ---------------------------------------------------------------------------
// The published worker state

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lifecycle {
    Stopped,
    Starting,
    Running,
    Stopping,
    Failed,
}

impl Lifecycle {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Stopping => "stopping",
            Self::Failed => "failed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "stopped" => Some(Self::Stopped),
            "starting" => Some(Self::Starting),
            "running" => Some(Self::Running),
            "stopping" => Some(Self::Stopping),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

/// The detached worker's published lifecycle. The dashboard reads only this to
/// know whether the MCP optimizer is starting, running, stopping, stopped, or
/// failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkerState {
    pub pid: u32,
    pub started_at: String,
    pub root: String,
    pub state_dir: String,
    pub lifecycle: Lifecycle,
    pub enabled: bool,
    pub draining: bool,
    pub harness_version: Option<String>,
    pub argv: Vec<String>,
    pub last_run_at: Option<String>,
    pub next_run_at: Option<String>,
    pub last_error: Option<String>,
    pub notice: Option<String>,
    pub updated_at: String,
}

impl WorkerState {
    pub fn to_json(&self) -> Value {
        let mut record = Map::new();
        record.insert("version".into(), Value::from(WORKER_VERSION));
        record.insert("pid".into(), Value::from(self.pid));
        record.insert("startedAt".into(), Value::from(self.started_at.clone()));
        record.insert("root".into(), Value::from(self.root.clone()));
        record.insert("stateDir".into(), Value::from(self.state_dir.clone()));
        record.insert("lifecycle".into(), Value::from(self.lifecycle.as_str()));
        record.insert("enabled".into(), Value::from(self.enabled));
        if self.draining {
            record.insert("draining".into(), Value::from(true));
        }
        record.insert(
            "harnessVersion".into(),
            self.harness_version
                .clone()
                .map(Value::from)
                .unwrap_or(Value::Null),
        );
        record.insert(
            "argv".into(),
            Value::Array(self.argv.iter().cloned().map(Value::from).collect()),
        );
        for (key, value) in [
            ("lastRunAt", &self.last_run_at),
            ("nextRunAt", &self.next_run_at),
            ("lastError", &self.last_error),
            ("notice", &self.notice),
        ] {
            record.insert(
                key.into(),
                value.clone().map(Value::from).unwrap_or(Value::Null),
            );
        }
        record.insert("updatedAt".into(), Value::from(self.updated_at.clone()));
        Value::Object(record)
    }

    pub fn parse(value: &Value) -> Option<Self> {
        let record = record(value)?;
        if record.get("version").and_then(Value::as_u64) != Some(WORKER_VERSION) {
            return None;
        }
        let pid = record.get("pid").and_then(number_field)?;
        if pid.fract() != 0.0 || pid <= 0.0 || pid > f64::from(u32::MAX) {
            return None;
        }
        let text = |key: &str| record.get(key).and_then(Value::as_str).map(str::to_string);
        let nullable = |key: &str| -> Option<Option<String>> {
            match record.get(key) {
                Some(Value::Null) => Some(None),
                Some(Value::String(value)) => Some(Some(value.clone())),
                _ => None,
            }
        };
        let lifecyle = Lifecycle::parse(record.get("lifecycle")?.as_str()?)?;
        let argv = record
            .get("argv")?
            .as_array()?
            .iter()
            .map(|entry| entry.as_str().map(str::to_string))
            .collect::<Option<Vec<String>>>()?;
        let draining = match record.get("draining") {
            None => false,
            Some(Value::Bool(value)) => *value,
            Some(_) => return None,
        };
        Some(Self {
            pid: pid as u32,
            started_at: text("startedAt")?,
            root: text("root")?,
            state_dir: text("stateDir")?,
            lifecycle: lifecyle,
            enabled: record.get("enabled")?.as_bool()?,
            draining,
            harness_version: nullable("harnessVersion")?,
            argv,
            last_run_at: nullable("lastRunAt")?,
            next_run_at: nullable("nextRunAt")?,
            last_error: nullable("lastError")?,
            notice: nullable("notice")?,
            updated_at: text("updatedAt")?,
        })
    }
}

pub fn parse_worker_state(text: &str) -> Option<WorkerState> {
    WorkerState::parse(&serde_json::from_str(text).ok()?)
}

pub fn read_worker_state(directory: &Path) -> Option<WorkerState> {
    let text = std::fs::read_to_string(worker_state_path(directory)).ok()?;
    parse_worker_state(&text)
}

pub fn write_worker_state(directory: &Path, state: &WorkerState) -> std::io::Result<()> {
    write_json_atomic(&worker_state_path(directory), &state.to_json())
}

// ---------------------------------------------------------------------------
// Control channel

/// The dashboard-to-worker channel. Commands are individual files created by
/// atomic rename, so the worker never reads a half-written command and their
/// names sort in submission order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Stop,
    Drain,
    Settings {
        interval_minutes: u32,
        max_per_hour: Option<u32>,
        max_pending: Option<u32>,
    },
}

impl Command {
    pub fn to_json(&self) -> Value {
        match self {
            Self::Stop => json!({ "type": "stop" }),
            Self::Drain => json!({ "type": "drain" }),
            Self::Settings {
                interval_minutes,
                max_per_hour,
                max_pending,
            } => json!({
                "type": "settings",
                "intervalMinutes": interval_minutes,
                "maxPerHour": max_per_hour,
                "maxPending": max_pending,
            }),
        }
    }
}

static COMMAND_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn write_command(directory: &Path, command: &Command) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(directory)?;
    let sequence = COMMAND_SEQUENCE.fetch_add(1, Ordering::SeqCst) + 1;
    let name = format!("{:014}-{:06}.json", now_millis(), sequence);
    let path = directory.join(name);
    let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    let mut text = crate::jsjson::stringify(&command.to_json());
    text.push('\n');
    std::fs::write(&temporary, text)?;
    std::fs::rename(&temporary, &path)?;
    Ok(path)
}

pub fn parse_command(text: &str) -> Option<Command> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    let record = record(&parsed)?;
    match record.get("type").and_then(Value::as_str)? {
        "stop" => Some(Command::Stop),
        "drain" => Some(Command::Drain),
        "settings" => {
            if !is_valid_cadence(record.get("intervalMinutes"))
                || !is_valid_limit(record.get("maxPerHour"))
                || !is_valid_limit(record.get("maxPending"))
            {
                return None;
            }
            Some(Command::Settings {
                interval_minutes: optional_number_field(record.get("intervalMinutes"))? as u32,
                max_per_hour: limit_of(record.get("maxPerHour"), None),
                max_pending: limit_of(record.get("maxPending"), None),
            })
        }
        _ => None,
    }
}

pub fn take_commands(directory: &Path) -> Vec<Command> {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.ends_with(".json"))
        .collect();
    names.sort();
    let mut commands = Vec::new();
    for name in names {
        let path = directory.join(name);
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let _ = std::fs::remove_file(&path);
        if let Some(command) = parse_command(&text) {
            commands.push(command);
        }
    }
    commands
}

// ---------------------------------------------------------------------------
// The ledger

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum FamilyKind {
    Command,
    Question,
    RunFailure,
}

impl FamilyKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Command => "command",
            Self::Question => "question",
            Self::RunFailure => "run-failure",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "command" => Some(Self::Command),
            "question" => Some(Self::Question),
            "run-failure" => Some(Self::RunFailure),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FamilyAction {
    Filed,
    Capped,
    None,
    Duplicate,
    Invalid,
    Failed,
}

impl FamilyAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Filed => "filed",
            Self::Capped => "capped",
            Self::None => "none",
            Self::Duplicate => "duplicate",
            Self::Invalid => "invalid",
            Self::Failed => "failed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "filed" => Some(Self::Filed),
            "capped" => Some(Self::Capped),
            "none" => Some(Self::None),
            "duplicate" => Some(Self::Duplicate),
            "invalid" => Some(Self::Invalid),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct FamilyEntry {
    pub first_seen: String,
    pub last_seen: String,
    pub calls: Value,
    pub sessions: Value,
    pub kind: FamilyKind,
    pub last_action: FamilyAction,
    pub last_issue_url: Option<String>,
    pub last_title: Option<String>,
    pub last_filed_at: Option<String>,
}

impl FamilyEntry {
    fn to_json(&self) -> Value {
        let mut record = Map::new();
        record.insert("firstSeen".into(), Value::from(self.first_seen.clone()));
        record.insert("lastSeen".into(), Value::from(self.last_seen.clone()));
        record.insert("calls".into(), self.calls.clone());
        record.insert("sessions".into(), self.sessions.clone());
        record.insert("kind".into(), Value::from(self.kind.as_str()));
        record.insert("lastAction".into(), Value::from(self.last_action.as_str()));
        if let Some(url) = &self.last_issue_url {
            record.insert("lastIssueUrl".into(), Value::from(url.clone()));
        }
        if let Some(title) = &self.last_title {
            record.insert("lastTitle".into(), Value::from(title.clone()));
        }
        if let Some(filed_at) = &self.last_filed_at {
            record.insert("lastFiledAt".into(), Value::from(filed_at.clone()));
        }
        Value::Object(record)
    }

    fn parse(value: &Value) -> Option<Self> {
        let record = record(value)?;
        let calls = record
            .get("calls")
            .filter(|value| number_field(value).is_some())?;
        let sessions = record
            .get("sessions")
            .filter(|value| number_field(value).is_some())?;
        Some(Self {
            first_seen: record.get("firstSeen")?.as_str()?.to_string(),
            last_seen: record.get("lastSeen")?.as_str()?.to_string(),
            calls: calls.clone(),
            sessions: sessions.clone(),
            kind: FamilyKind::parse(record.get("kind")?.as_str()?)?,
            last_action: FamilyAction::parse(record.get("lastAction")?.as_str()?)?,
            last_issue_url: record
                .get("lastIssueUrl")
                .and_then(Value::as_str)
                .map(str::to_string),
            last_title: record
                .get("lastTitle")
                .and_then(Value::as_str)
                .map(str::to_string),
            last_filed_at: record
                .get("lastFiledAt")
                .and_then(Value::as_str)
                .map(str::to_string),
        })
    }
}

/// A validated proposal a cap held back; filed with its original bytes.
#[derive(Clone, Debug)]
pub struct PendingFiling {
    pub family: String,
    pub kind: FamilyKind,
    pub title: String,
    pub body: String,
    pub score: Value,
    pub created_at: String,
}

impl PendingFiling {
    fn to_json(&self) -> Value {
        let mut record = Map::new();
        record.insert("family".into(), Value::from(self.family.clone()));
        record.insert("kind".into(), Value::from(self.kind.as_str()));
        record.insert("title".into(), Value::from(self.title.clone()));
        record.insert("body".into(), Value::from(self.body.clone()));
        record.insert("score".into(), self.score.clone());
        record.insert("createdAt".into(), Value::from(self.created_at.clone()));
        Value::Object(record)
    }

    fn parse(value: &Value) -> Option<Self> {
        let record = record(value)?;
        let score = record
            .get("score")
            .filter(|value| number_field(value).is_some())?;
        let created_at = record.get("createdAt")?.as_str()?.to_string();
        parse_instant(&created_at)?;
        let kind = record
            .get("kind")
            .and_then(Value::as_str)
            .and_then(FamilyKind::parse)
            .unwrap_or(FamilyKind::Command);
        Some(Self {
            family: record.get("family")?.as_str()?.to_string(),
            kind,
            title: record.get("title")?.as_str()?.to_string(),
            body: record.get("body")?.as_str()?.to_string(),
            score: score.clone(),
            created_at,
        })
    }
}

/// The version-3 ledger: the newest evidence per family, the last action taken
/// for it, and the proposals a cap held back. Entries keep their file order, so
/// a rewrite never reorders them.
#[derive(Clone, Debug, Default)]
pub struct Ledger {
    pub families: Vec<(String, FamilyEntry)>,
    pub pending_filing: Vec<PendingFiling>,
}

impl Ledger {
    pub fn empty() -> Self {
        Self::default()
    }

    pub fn entry(&self, key: &str) -> Option<&FamilyEntry> {
        self.families
            .iter()
            .find(|(family, _)| family == key)
            .map(|(_, entry)| entry)
    }

    pub fn entry_mut(&mut self, key: &str) -> Option<&mut FamilyEntry> {
        self.families
            .iter_mut()
            .find(|(family, _)| family == key)
            .map(|(_, entry)| entry)
    }

    pub fn to_json(&self) -> Value {
        let mut families = Map::new();
        for (key, entry) in &self.families {
            families.insert(key.clone(), entry.to_json());
        }
        let mut record = Map::new();
        record.insert("version".into(), Value::from(LEDGER_VERSION));
        record.insert("families".into(), Value::Object(families));
        record.insert(
            "pendingFiling".into(),
            Value::Array(
                self.pending_filing
                    .iter()
                    .map(PendingFiling::to_json)
                    .collect(),
            ),
        );
        Value::Object(record)
    }
}

/// A loaded ledger, and whether a non-version-3 file was discarded.
pub struct LedgerLoad {
    pub ledger: Ledger,
    pub reset: bool,
}

pub fn load_ledger(directory: &Path) -> LedgerLoad {
    let Some(parsed) = read_json(&ledger_path(directory)) else {
        return LedgerLoad {
            ledger: Ledger::empty(),
            reset: false,
        };
    };
    let Some(record) = record(&parsed) else {
        return LedgerLoad {
            ledger: Ledger::empty(),
            reset: true,
        };
    };
    if record.get("version").and_then(Value::as_u64) != Some(LEDGER_VERSION) {
        return LedgerLoad {
            ledger: Ledger::empty(),
            reset: true,
        };
    }
    let mut families = Ledger::empty();
    if let Some(entries) = record.get("families").and_then(Value::as_object) {
        for (key, value) in entries {
            if let Some(entry) = FamilyEntry::parse(value) {
                families.families.push((key.clone(), entry));
            }
        }
    }
    let pending_filing = record
        .get("pendingFiling")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(PendingFiling::parse)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    LedgerLoad {
        ledger: Ledger {
            families: families.families,
            pending_filing,
        },
        reset: false,
    }
}

pub fn save_ledger(directory: &Path, ledger: &Ledger) -> std::io::Result<()> {
    write_json_atomic(&ledger_path(directory), &ledger.to_json())
}

/// Records this cycle's families. A family keeps its earliest sighting and
/// carries the newest window's counts; the last action is untouched.
pub fn record_families(ledger: &mut Ledger, families: &[Family], now: OffsetDateTime) {
    let stamp = iso(now);
    for family in families {
        let first = if family.first_at < stamp {
            family.first_at.clone()
        } else {
            stamp.clone()
        };
        if let Some(entry) = ledger.entry_mut(&family.key) {
            if family.first_at < entry.first_seen {
                entry.first_seen = family.first_at.clone();
            }
            entry.last_seen = family.last_at.clone();
            entry.calls = number_value(family.calls as f64);
            entry.sessions = number_value(family.sessions.len() as f64);
            entry.kind = family.kind;
            continue;
        }
        ledger.families.push((
            family.key.clone(),
            FamilyEntry {
                first_seen: first,
                last_seen: family.last_at.clone(),
                calls: number_value(family.calls as f64),
                sessions: number_value(family.sessions.len() as f64),
                kind: family.kind,
                last_action: FamilyAction::None,
                last_issue_url: None,
                last_title: None,
                last_filed_at: None,
            },
        ));
    }
}

pub struct MarkOptions {
    pub at: OffsetDateTime,
    pub issue_url: Option<String>,
    pub title: Option<String>,
}

pub fn mark_family(ledger: &mut Ledger, key: &str, action: FamilyAction, options: &MarkOptions) {
    let at = iso(options.at);
    let Some(entry) = ledger.entry_mut(key) else {
        return;
    };
    entry.last_action = action;
    if action == FamilyAction::Filed {
        if let Some(url) = &options.issue_url {
            entry.last_issue_url = Some(url.clone());
        }
        if let Some(title) = &options.title {
            entry.last_title = Some(title.clone());
        }
        entry.last_filed_at = Some(at);
    }
}

// ---------------------------------------------------------------------------
// The stable family identity

/// The tag a filed body carries: `family:` plus the first 12 hex of SHA-256.
pub fn family_tag(key: &str) -> String {
    let digest = Sha256::digest(key.as_bytes());
    hex::encode(digest)[..12].to_string()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenIssue {
    pub number: u64,
    pub title: String,
    pub body: String,
    pub url: String,
}

// ---------------------------------------------------------------------------
// Tool log

/// One line the Devboard MCP server appended for a mutating tool call.
pub fn read_tool_log(path: &Path) -> Vec<Value> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    text.split('\n')
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }
            serde_json::from_str::<Value>(trimmed)
                .ok()
                .filter(Value::is_object)
        })
        .collect()
}

pub fn tool_value_number(value: &Value, field: &str) -> Option<u64> {
    let amount = optional_number_field(value.as_object()?.get(field))?;
    if amount.fract() != 0.0 || amount <= 0.0 {
        return None;
    }
    Some(amount as u64)
}

pub fn tool_value_string(value: &Value, field: &str) -> Option<String> {
    value.as_object()?.get(field)?.as_str().map(str::to_string)
}

// ---------------------------------------------------------------------------
// Path arithmetic

/// Resolves a path the way `path.resolve` does: lexically, without touching
/// the filesystem.
pub fn resolve(path: &Path) -> PathBuf {
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
                if matches!(
                    normalized.components().next_back(),
                    Some(Component::Normal(_))
                ) {
                    normalized.pop();
                } else if !path.is_absolute() {
                    normalized.push("..");
                }
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

/// `path.relative(from, to)`, with forward slashes and `..` segments.
pub fn relative_path(from: &Path, to: &Path) -> String {
    let from = normalize(&resolve(from));
    let to = normalize(&resolve(to));
    let mut from_parts: Vec<String> = from
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect();
    let mut to_parts: Vec<String> = to
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect();
    let mut common = 0;
    while common < from_parts.len()
        && common < to_parts.len()
        && from_parts[common] == to_parts[common]
    {
        common += 1;
    }
    let mut parts: Vec<String> = Vec::new();
    parts.extend(std::iter::repeat_n(
        "..".to_string(),
        from_parts.len() - common,
    ));
    parts.extend(to_parts.drain(common..));
    from_parts.clear();
    if parts.is_empty() {
        return String::new();
    }
    parts.join("/")
}

fn trailing_slashes_trimmed(path: &Path) -> String {
    let text = resolve(path).to_string_lossy().into_owned();
    text.trim_end_matches('/').to_string()
}

// ---------------------------------------------------------------------------
// Bound helpers shared by the family pipeline

/// JavaScript's `slice(0, max - 1).trimEnd() + "…"` over UTF-16 code units.
pub fn bound(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    let cut: String = value.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", cut.trim_end())
}

fn collapse_whitespace(value: &str) -> String {
    static SPACES: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"\s+").expect("a whitespace regex"));
    SPACES.replace_all(value, " ").trim().to_string()
}

// ---------------------------------------------------------------------------
// ACP session transcripts

/// The newest selected transcript files one cycle may read.
pub const SESSION_MAX_FILES: usize = 1_000;
/// How much of a transcript the header scan reads before giving up.
const HEADER_SCAN_BYTES: u64 = 64 * 1024;
pub const SESSION_MESSAGE_TEXT_MAX: usize = 4_000;

#[derive(Clone, Debug, PartialEq)]
pub struct SessionToolCall {
    pub id: Option<String>,
    pub name: String,
    pub arguments_text: String,
    pub command: Option<String>,
    pub index: u64,
    pub timestamp: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SessionToolResult {
    pub tool_call_id: Option<String>,
    pub tool_name: String,
    pub text: String,
    pub is_error: bool,
    pub index: u64,
    pub timestamp: Option<String>,
}

/// One parsed ACP transcript.
#[derive(Clone, Debug, PartialEq)]
pub struct Session {
    pub id: String,
    pub path: String,
    pub relative_path: String,
    pub started_at: String,
    pub title: String,
    pub cwd: String,
    pub relative_cwd: String,
    pub calls: Vec<SessionToolCall>,
    pub results: Vec<SessionToolResult>,
}

pub struct ParsedTranscript {
    pub session: Option<Session>,
    pub malformed: usize,
}

struct SessionHeader {
    id: String,
    cwd: String,
    started_at: String,
}

fn text_parts(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| {
                let part = part.as_object()?;
                if part.get("type")?.as_str()? != "text" {
                    return None;
                }
                part.get("text")?.as_str().map(str::to_string)
            })
            .collect::<Vec<String>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn uuid_pattern() -> &'static regex::Regex {
    static PATTERN: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
            .expect("a uuid regex")
    });
    &PATTERN
}

fn timestamp_pattern() -> &'static regex::Regex {
    static PATTERN: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?")
            .expect("a timestamp regex")
    });
    &PATTERN
}

fn hex_pattern() -> &'static regex::Regex {
    static PATTERN: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)\b[0-9a-f]{7,}\b").expect("a hex regex")
    });
    &PATTERN
}

/// Collapses whitespace and replaces volatile tokens; deterministic.
pub fn normalize_session_line(text: &str, repo_dir: Option<&Path>) -> String {
    let mut value = collapse_whitespace(text);
    if let Some(root) = repo_dir {
        let root = trailing_slashes_trimmed(root);
        if !root.is_empty() {
            value = value.replace(&root, "<repo>");
        }
    }
    value = uuid_pattern().replace_all(&value, "<uuid>").into_owned();
    value = timestamp_pattern()
        .replace_all(&value, "<timestamp>")
        .into_owned();
    value = hex_pattern().replace_all(&value, "<hex>").into_owned();
    collapse_whitespace(&value)
}

fn first_user_line(records: &[Value]) -> String {
    for record in records {
        let Some(record) = record.as_object() else {
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
            return line.chars().take(120).collect();
        }
    }
    String::new()
}

/// Parses one transcript. The result carries the parsed session when a usable
/// `session` record exists; malformed lines are counted even then.
pub fn parse_session_transcript(
    text: &str,
    path: &Path,
    state_dir: &Path,
    repo_dir: &Path,
) -> ParsedTranscript {
    let mut records = Vec::new();
    let mut malformed = 0;
    for line in text.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(line) {
            Ok(parsed) if parsed.is_object() => records.push(parsed),
            _ => malformed += 1,
        }
    }
    parse_session_records(&records, malformed, path, state_dir, repo_dir)
}

fn parse_session_records(
    records: &[Value],
    malformed: usize,
    path: &Path,
    state_dir: &Path,
    repo_dir: &Path,
) -> ParsedTranscript {
    let mut session_id: Option<String> = None;
    let mut session_started: Option<String> = None;
    let mut session_cwd: Option<String> = None;
    let mut title = String::new();
    for record in records {
        let Some(record) = record.as_object() else {
            continue;
        };
        match record.get("type").and_then(Value::as_str) {
            Some("session") if session_id.is_none() => {
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
                if let Some(started) = record
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .and_then(parse_instant)
                {
                    session_started = Some(iso(started));
                }
            }
            Some("title") => {
                if let Some(value) = record.get("title").and_then(Value::as_str) {
                    let trimmed = value.trim();
                    if !trimmed.is_empty() {
                        title = trimmed.chars().take(200).collect();
                    }
                }
            }
            _ => {}
        }
    }
    let (Some(session_id), Some(session_started), Some(session_cwd)) =
        (session_id, session_started, session_cwd)
    else {
        return ParsedTranscript {
            session: None,
            malformed,
        };
    };

    let absolute_cwd = resolve(Path::new(&session_cwd));
    let absolute_repo = resolve(repo_dir);
    let local = relative_path(&absolute_repo, &absolute_cwd);
    let relative_cwd = if local.is_empty() {
        ".".to_string()
    } else if local.starts_with("..") {
        absolute_cwd.to_string_lossy().into_owned()
    } else {
        local
    };

    let mut calls = Vec::new();
    let mut results = Vec::new();
    let mut index: u64 = 0;
    for record in records {
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
            .unwrap_or("other");
        let timestamp = record
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_instant)
            .map(iso);
        let content = message.get("content");

        if role == "toolResult" {
            let tool_name = message
                .get("toolName")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            let result_text: String = text_parts(content)
                .chars()
                .take(SESSION_MESSAGE_TEXT_MAX * 4)
                .collect();
            let is_error = message
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let tool_call_id = message
                .get("toolCallId")
                .and_then(Value::as_str)
                .map(str::to_string);
            results.push(SessionToolResult {
                tool_call_id,
                tool_name,
                text: result_text,
                is_error,
                index,
                timestamp,
            });
            index += 1;
            continue;
        }

        let text = text_parts(content);
        let parts = content
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut emitted = false;
        for part in &parts {
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
            let arguments = part
                .get("arguments")
                .filter(|value| value.is_object())
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new()));
            let arguments_text =
                normalize_session_line(&crate::jsjson::stringify(&arguments), Some(&absolute_repo));
            let command = arguments
                .as_object()
                .and_then(|record| record.get("command"))
                .and_then(Value::as_str)
                .map(str::to_string);
            calls.push(SessionToolCall {
                id,
                name,
                arguments_text,
                command,
                index,
                timestamp: timestamp.clone(),
            });
            index += 1;
            emitted = true;
        }
        if !emitted && (!text.is_empty() || role != "assistant") {
            index += 1;
        }
    }

    let relative = relative_path(&resolve(state_dir), &resolve(path));
    ParsedTranscript {
        session: Some(Session {
            id: session_id,
            path: resolve(path).to_string_lossy().into_owned(),
            relative_path: relative,
            started_at: session_started,
            title: if title.is_empty() {
                first_user_line(records)
            } else {
                title
            },
            cwd: absolute_cwd.to_string_lossy().into_owned(),
            relative_cwd,
            calls,
            results,
        }),
        malformed,
    }
}

struct SessionFileMeta {
    path: PathBuf,
    mtime_ms: i64,
}

fn file_mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// Every `.jsonl` transcript under the providers agent sessions tree.
fn list_session_paths(state_dir: &Path) -> Vec<PathBuf> {
    let root = resolve(state_dir).join("providers").join("agents");
    let mut files = Vec::new();
    let Ok(agents) = std::fs::read_dir(&root) else {
        return files;
    };
    let mut names: Vec<PathBuf> = agents
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .map(|entry| root.join(entry.file_name()))
        .collect();
    names.sort();
    fn walk(directory: &Path, files: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(directory) else {
            return;
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                walk(&path, files);
            } else if kind.is_file() && entry.file_name().to_string_lossy().ends_with(".jsonl") {
                files.push(path);
            }
        }
    }
    for agent in names {
        walk(&agent.join("sessions"), &mut files);
    }
    files.sort();
    files
}

fn list_session_files(state_dir: &Path) -> Vec<SessionFileMeta> {
    let mut files: Vec<SessionFileMeta> = list_session_paths(state_dir)
        .into_iter()
        .filter_map(|path| {
            let meta = std::fs::metadata(&path).ok()?;
            if !meta.is_file() {
                return None;
            }
            let _ = meta.len();
            Some(SessionFileMeta {
                path,
                mtime_ms: file_mtime_ms(&meta),
            })
        })
        .collect();
    files.sort_by(|left, right| left.path.cmp(&right.path));
    files
}

fn parse_session_header_text(text: &str) -> Option<SessionHeader> {
    for line in text.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(record) = record.as_object() else {
            continue;
        };
        if record.get("type").and_then(Value::as_str) != Some("session") {
            continue;
        }
        let id = record.get("id").and_then(Value::as_str)?;
        if id.is_empty() {
            return None;
        }
        let cwd = record.get("cwd").and_then(Value::as_str)?;
        if cwd.is_empty() {
            return None;
        }
        let started = record.get("timestamp").and_then(Value::as_str)?;
        let started = parse_instant(started)?;
        return Some(SessionHeader {
            id: id.to_string(),
            cwd: cwd.to_string(),
            started_at: iso(started),
        });
    }
    None
}

fn read_session_header(meta: &SessionFileMeta) -> Option<SessionHeader> {
    use std::io::Read;
    let mut file = std::fs::File::open(&meta.path).ok()?;
    let mut buffer = vec![0_u8; HEADER_SCAN_BYTES as usize];
    let read = file.read(&mut buffer).ok()?;
    buffer.truncate(read);
    parse_session_header_text(&String::from_utf8_lossy(&buffer))
}

/// True when the cwd is the repository root or inside its `.worktree/`.
pub fn is_repository_working_directory(repo_dir: &Path, cwd: &str) -> bool {
    let root = resolve(repo_dir);
    let target = resolve(Path::new(cwd));
    if target == root {
        return true;
    }
    target.starts_with(root.join(".worktree"))
}

/// A session selection: the parsed sessions and the counters a cycle reports.
pub struct SessionSelection {
    pub sessions: Vec<Session>,
    pub selected: usize,
    pub omitted: usize,
    pub truncated: bool,
    pub skipped: usize,
    pub malformed: usize,
}

/// Every transcript whose session cwd is this repository (or a worktree under
/// it), deduplicated by session id and ordered newest first.
pub fn select_sessions(
    state_dir: &Path,
    repo_dir: &Path,
    mtime_since: Option<i64>,
    max_files: Option<usize>,
) -> SessionSelection {
    let max_files = max_files.unwrap_or(SESSION_MAX_FILES).max(1);
    let entries: Vec<SessionFileMeta> = list_session_files(state_dir)
        .into_iter()
        .filter(|meta| {
            mtime_since
                .map(|since| meta.mtime_ms >= since)
                .unwrap_or(true)
        })
        .collect();
    let mut skipped = 0;
    let mut by_id: BTreeMap<String, (SessionFileMeta, SessionHeader)> = BTreeMap::new();
    for meta in entries {
        let Some(header) = read_session_header(&meta) else {
            skipped += 1;
            continue;
        };
        if !is_repository_working_directory(repo_dir, &header.cwd) {
            continue;
        }
        let replace = match by_id.get(&header.id) {
            None => true,
            Some((existing_meta, existing)) => {
                header.started_at > existing.started_at
                    || (header.started_at == existing.started_at && meta.path > existing_meta.path)
            }
        };
        if replace {
            by_id.insert(header.id.clone(), (meta, header));
        }
    }
    let mut ordered: Vec<(SessionFileMeta, SessionHeader)> = by_id.into_values().collect();
    ordered.sort_by(|left, right| {
        right
            .1
            .started_at
            .cmp(&left.1.started_at)
            .then_with(|| left.0.path.cmp(&right.0.path))
    });
    let matching = ordered.len();
    let kept: Vec<(SessionFileMeta, SessionHeader)> = ordered.into_iter().take(max_files).collect();
    let mut sessions = Vec::new();
    let mut malformed = 0;
    for (meta, _) in &kept {
        let Some(text) = std::fs::read_to_string(&meta.path).ok() else {
            skipped += 1;
            continue;
        };
        let parsed = parse_session_transcript(&text, &meta.path, state_dir, repo_dir);
        malformed += parsed.malformed;
        match parsed.session {
            Some(session) => sessions.push(session),
            None => skipped += 1,
        }
    }
    sessions.sort_by(|left, right| {
        left.started_at
            .cmp(&right.started_at)
            .then_with(|| left.path.cmp(&right.path))
    });
    SessionSelection {
        sessions,
        selected: matching,
        omitted: matching - kept.len(),
        truncated: matching > kept.len(),
        skipped,
        malformed,
    }
}

// ---------------------------------------------------------------------------
// Families

/// Read-only inspection every agent performs; never a family.
pub const TRIVIAL_COMMANDS: &[&str] = &[
    "ls",
    "pwd",
    "cat",
    "head",
    "tail",
    "wc",
    "echo",
    "printf",
    "grep",
    "rg",
    "find",
    "sed -n",
    "git status",
    "git diff",
    "git log",
    "git show",
    "git branch",
    "git rev-parse",
    "git worktree list",
    "git ls-remote",
    "git remote -v",
    "bun test",
    "bun run check",
    "bun run build",
    "bunx tsc --noEmit",
];

fn trivial_keys() -> &'static Vec<String> {
    static KEYS: std::sync::LazyLock<Vec<String>> = std::sync::LazyLock::new(|| {
        let mut keys: Vec<String> = Vec::new();
        for entry in TRIVIAL_COMMANDS {
            let key = family_key(entry);
            if !keys.contains(&key) {
                keys.push(key);
            }
        }
        keys
    });
    &KEYS
}

/// True when a normalized signature or family key is plain inspection, not a
/// capability gap.
pub fn is_trivial_command(signature: &str) -> bool {
    trivial_keys()
        .iter()
        .any(|prefix| signature == prefix || signature.starts_with(&format!("{prefix} ")))
}

/// The fixed evidence window: the 24 hours ending at cycle start.
pub const EVIDENCE_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;
/// One cycle synthesizes at most this many families.
pub const MAX_SELECTED_FAMILIES: usize = 20;
/// One family's evidence bundle quotes at most this many excerpts.
pub const FAMILY_EXCERPT_LIMIT: usize = 5;
pub const EXCERPT_COMMAND_MAX: usize = 300;
pub const EXCERPT_OUTPUT_MAX: usize = 2_000;
pub const EXCERPT_OUTPUT_LINES: usize = 10;
/// A retry loop adds this much weight to its command family.
pub const RETRY_WEIGHT: i64 = 1;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FamilyFragment {
    pub text: String,
    pub count: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FamilyExcerpt {
    /// The command (or journal text), bounded to 300 characters.
    pub command: String,
    /// `error`, `ok`, or `n/a` for a journal record.
    pub status: String,
    /// At most 10 lines and 2,000 characters.
    pub output: String,
    pub session_title: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Family {
    pub key: String,
    pub kind: FamilyKind,
    pub calls: i64,
    /// Contributing session ids (journal scopes for a journal family), sorted.
    pub sessions: Vec<String>,
    /// Distinct UTC days the evidence falls on.
    pub days: usize,
    pub first_at: String,
    pub last_at: String,
    /// `sessions * days * calls`, computed after normalization.
    pub score: i64,
    pub fragments: Vec<FamilyFragment>,
    pub excerpts: Vec<FamilyExcerpt>,
}

/// One journal record the family builder reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JournalRecord {
    pub kind: String,
    pub ts: String,
    pub text: String,
    pub scope: Option<String>,
}

/// The families a window produced: every family by key, the selection by
/// score, and how many the cap omitted.
pub struct FamilySelection {
    pub families: Vec<Family>,
    pub selected: Vec<Family>,
    pub omitted: usize,
}

const MUTATING_TOOLS: &[&str] = &[
    "bash",
    "edit",
    "multiedit",
    "write",
    "apply_patch",
    "patch",
    "ast_edit",
];

fn fixture_command(command: &str) -> bool {
    let value = command.trim();
    if value == "true" || value == "i: noop" {
        return true;
    }
    value == "echo" || value.starts_with("echo ")
}

fn excluded_path(value: &str) -> bool {
    value.contains(".worktree/") || value.contains(".devboard/.tmp/")
}

fn mcp_optimizer_owned(value: &str) -> bool {
    value.contains(".devboard/mcp-optimizer") || value.contains("verify:mcp-optimizer")
}

fn excluded_session(session: &Session) -> bool {
    [&session.relative_cwd, &session.relative_path]
        .iter()
        .any(|value| excluded_path(value) || mcp_optimizer_owned(value))
}

/// Removes the repository root so a command that names it is judged
/// relatively.
fn repo_relative(value: &str, repo_dir: &Path) -> String {
    let root = trailing_slashes_trimmed(repo_dir);
    if root.is_empty() {
        value.to_string()
    } else {
        value.replace(&root, "")
    }
}

/// Splits on `&&`, `||`, and `;` outside quotes.
fn split_segments(value: &str) -> Vec<String> {
    let characters: Vec<char> = value.chars().collect();
    let mut segments: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut index = 0;
    while index < characters.len() {
        let character = characters[index];
        if let Some(active) = quote {
            current.push(character);
            if character == active {
                quote = None;
            }
            index += 1;
            continue;
        }
        if character == '"' || character == '\'' {
            quote = Some(character);
            current.push(character);
            index += 1;
            continue;
        }
        let next = characters.get(index + 1).copied();
        if (character == '&' && next == Some('&')) || (character == '|' && next == Some('|')) {
            segments.push(std::mem::take(&mut current));
            index += 2;
            continue;
        }
        if character == ';' {
            segments.push(std::mem::take(&mut current));
            index += 1;
            continue;
        }
        current.push(character);
        index += 1;
    }
    segments.push(current);
    segments
        .into_iter()
        .map(|segment| segment.trim().to_string())
        .filter(|segment| !segment.is_empty())
        .collect()
}

/// Cuts a segment at its first pipe, leaving `||` alone.
fn strip_pipes(value: &str) -> String {
    let characters: Vec<char> = value.chars().collect();
    let mut result = String::new();
    let mut quote: Option<char> = None;
    let mut index = 0;
    while index < characters.len() {
        let character = characters[index];
        if let Some(active) = quote {
            result.push(character);
            if character == active {
                quote = None;
            }
            index += 1;
            continue;
        }
        if character == '"' || character == '\'' {
            quote = Some(character);
            result.push(character);
            index += 1;
            continue;
        }
        if character == '|' {
            if characters.get(index + 1) == Some(&'|') {
                result.push(character);
                index += 1;
                continue;
            }
            break;
        }
        result.push(character);
        index += 1;
    }
    result
}

/// Removes `2>&1`, `> path`, `2> path`, `>> path`, and `< path`.
fn strip_redirections(value: &str) -> String {
    static REDIRECT: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r#"\s+\d?>>?\s*(?:"[^"]*"|'[^']*'|\S+)"#).expect("a redirect regex")
    });
    static MERGE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"\s*(?:\d?>&\d|&>\d?)\s*").expect("a merge regex")
    });
    static INPUT: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r#"\s+<\s*(?:"[^"]*"|'[^']*'|\S+)"#).expect("an input regex")
    });
    let value = REDIRECT.replace_all(value, "");
    let value = MERGE.replace_all(&value, " ");
    let value = INPUT.replace_all(&value, "");
    collapse_whitespace(&value)
}

fn unwrap_parenthesized(value: &str) -> String {
    static PARENS: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?s)^\(\s*(.*)\)$").expect("a paren regex")
    });
    match PARENS.captures(value) {
        Some(captures) => captures
            .get(1)
            .map(|inner| inner.as_str().trim().to_string())
            .unwrap_or_else(|| value.to_string()),
        None => value.to_string(),
    }
}

/// The volatile-token replacements shared with the old detector.
fn replace_volatile(value: &str, repo_dir: &Path) -> String {
    static ENV: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r#"^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+"#)
            .expect("an env regex")
    });
    static WORKTREE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"\.worktree/[^\s/]+").expect("a worktree regex")
    });
    static GIT_DIRECTORY: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r#"^(?:git -C (?:"[^"]*"|'[^']*'|\S+) )"#).expect("a git regex")
    });
    let mut result = ENV.replace(value, "<env> ").into_owned();
    let root = trailing_slashes_trimmed(repo_dir);
    if !root.is_empty() {
        result = result.replace(&root, "<repo>");
    }
    result = WORKTREE
        .replace_all(&result, ".worktree/<worktree>")
        .into_owned();
    result = uuid_pattern().replace_all(&result, "<uuid>").into_owned();
    result = timestamp_pattern()
        .replace_all(&result, "<timestamp>")
        .into_owned();
    result = hex_pattern().replace_all(&result, "<hex>").into_owned();
    result = collapse_whitespace(&result);
    if let Some(rest) = result.strip_prefix("<env> ") {
        result = rest.to_string();
    }
    result = GIT_DIRECTORY.replace(&result, "git ").into_owned();
    result.trim().to_string()
}

/// The family key: the remaining tokens up to the first `--flag`.
pub fn family_key(normalized: &str) -> String {
    let tokens: Vec<&str> = normalized
        .split(' ')
        .filter(|token| !token.is_empty())
        .collect();
    match tokens.iter().position(|token| token.starts_with("--")) {
        Some(flag) => tokens[..flag].join(" "),
        None => tokens.join(" "),
    }
}

/// One bash command to its normalized family key. Pipes are output handling,
/// redirections are noise, and the directory change is not the command.
pub fn normalize_command_signature(command: &str, repo_dir: &Path) -> String {
    let segments = split_segments(&unwrap_parenthesized(command.trim()));
    let commands: Vec<String> = segments
        .iter()
        .map(|segment| replace_volatile(&strip_redirections(&strip_pipes(segment)), repo_dir))
        .filter(|segment| !segment.is_empty() && segment != "cd" && !segment.starts_with("cd "))
        .collect();
    let chosen = commands
        .iter()
        .find(|segment| !is_trivial_command(segment))
        .or_else(|| commands.first())
        .cloned()
        .unwrap_or_default();
    family_key(&chosen)
}

fn excerpt_of(command: &str, status: &str, output: &str, session_title: &str) -> FamilyExcerpt {
    let lines: Vec<&str> = output
        .split('\n')
        .take(EXCERPT_OUTPUT_LINES)
        .map(str::trim_end)
        .collect();
    FamilyExcerpt {
        command: bound(&collapse_whitespace(command), EXCERPT_COMMAND_MAX),
        status: status.to_string(),
        output: bound(&lines.join("\n"), EXCERPT_OUTPUT_MAX),
        session_title: bound(&collapse_whitespace(session_title), 120),
    }
}

struct Occurrence {
    key: String,
    kind: FamilyKind,
    at: i64,
    session: String,
    fragment: String,
    excerpt: FamilyExcerpt,
    excerpt_rank: u8,
    weight: i64,
}

fn instant_of(value: Option<&str>, fallback: &str) -> i64 {
    value
        .and_then(parse_instant_millis)
        .or_else(|| parse_instant_millis(fallback))
        .unwrap_or(0)
}

fn result_for<'a>(session: &'a Session, call: &SessionToolCall) -> Option<&'a SessionToolResult> {
    let id = call.id.as_ref()?;
    session
        .results
        .iter()
        .find(|result| result.tool_call_id.as_ref() == Some(id))
}

fn call_identity(call: &SessionToolCall) -> String {
    format!("{}\n{}", call.name, call.arguments_text)
}

struct RetryWeight {
    count: i64,
    at: i64,
}

/// Retry weight: one identity repeated at least three times after errors.
fn retry_weights(session: &Session, start: i64, end: i64) -> HashMap<String, RetryWeight> {
    let mut calls_by_id: HashMap<&str, &SessionToolCall> = HashMap::new();
    let mut calls_by_index: HashMap<u64, &SessionToolCall> = HashMap::new();
    for call in &session.calls {
        if let Some(id) = &call.id {
            calls_by_id.insert(id, call);
        }
        calls_by_index.insert(call.index, call);
    }
    struct Event {
        index: u64,
        error: bool,
        identity: String,
    }
    let mut events: Vec<Event> = session
        .calls
        .iter()
        .map(|call| Event {
            index: call.index,
            error: false,
            identity: call_identity(call),
        })
        .collect();
    for result in &session.results {
        if !result.is_error {
            continue;
        }
        let origin = result
            .tool_call_id
            .as_ref()
            .and_then(|id| calls_by_id.get(id.as_str()))
            .copied();
        events.push(Event {
            index: result.index,
            error: true,
            identity: origin
                .map(call_identity)
                .unwrap_or_else(|| result.tool_name.clone()),
        });
    }
    events.sort_by_key(|event| event.index);

    struct Total {
        count: i64,
        after_error: i64,
        times: Vec<i64>,
    }
    let mut errored: HashSet<String> = HashSet::new();
    let mut totals: HashMap<String, Total> = HashMap::new();
    for event in &events {
        if event.error {
            errored.insert(event.identity.clone());
            continue;
        }
        let entry = totals.entry(event.identity.clone()).or_insert(Total {
            count: 0,
            after_error: 0,
            times: Vec::new(),
        });
        entry.count += 1;
        if errored.contains(&event.identity) {
            entry.after_error += 1;
        }
        let call = calls_by_index.get(&event.index).copied();
        let instant = instant_of(
            call.and_then(|call| call.timestamp.as_deref()),
            &session.started_at,
        );
        if instant >= start && instant <= end {
            entry.times.push(instant);
        }
        let outcome = call.and_then(|call| result_for(session, call));
        if let Some(outcome) = outcome {
            if !outcome.is_error {
                errored.remove(&event.identity);
            }
        }
    }
    let mut weights = HashMap::new();
    for (identity, entry) in totals {
        if entry.count < 3 || entry.after_error < 2 || entry.times.is_empty() {
            continue;
        }
        let at = entry.times.iter().copied().min().unwrap_or(0);
        weights.insert(
            identity,
            RetryWeight {
                count: entry.count,
                at,
            },
        );
    }
    weights
}

fn occurrences(sessions: &[Session], start: i64, end: i64, repo_dir: &Path) -> Vec<Occurrence> {
    let mut found = Vec::new();
    for session in sessions {
        if excluded_session(session) {
            continue;
        }
        for call in &session.calls {
            let at = instant_of(call.timestamp.as_deref(), &session.started_at);
            if at < start || at > end {
                continue;
            }
            let result = result_for(session, call);
            if call.name == "bash" {
                let Some(command) = call.command.as_deref() else {
                    continue;
                };
                let relative = repo_relative(command, repo_dir);
                if excluded_path(&relative)
                    || mcp_optimizer_owned(&relative)
                    || fixture_command(command)
                    || excluded_path(&session.relative_cwd)
                {
                    continue;
                }
                let key = normalize_command_signature(command, repo_dir);
                if key.is_empty() || is_trivial_command(&key) {
                    continue;
                }
                let is_error = result.map(|result| result.is_error).unwrap_or(false);
                found.push(Occurrence {
                    key,
                    kind: FamilyKind::Command,
                    at,
                    session: session.id.clone(),
                    fragment: command.to_string(),
                    excerpt: excerpt_of(
                        command,
                        if is_error { "error" } else { "ok" },
                        result.map(|result| result.text.as_str()).unwrap_or(""),
                        &session.title,
                    ),
                    excerpt_rank: if is_error { 0 } else { 1 },
                    weight: 1,
                });
                continue;
            }
            if MUTATING_TOOLS.contains(&call.name.as_str())
                && result.map(|result| result.is_error).unwrap_or(false)
            {
                let result = result.expect("an errored result");
                let arguments_text = normalize_session_line(&call.arguments_text, Some(repo_dir));
                found.push(Occurrence {
                    key: call.name.clone(),
                    kind: FamilyKind::Command,
                    at,
                    session: session.id.clone(),
                    fragment: arguments_text.clone(),
                    excerpt: excerpt_of(
                        &format!("{} {}", call.name, arguments_text),
                        "error",
                        &result.text,
                        &session.title,
                    ),
                    excerpt_rank: 0,
                    weight: 1,
                });
            }
        }
        for (identity, retry) in retry_weights(session, start, end) {
            let (name, arguments_text) = match identity.split_once('\n') {
                Some(parts) => parts,
                None => continue,
            };
            if name != "bash" {
                continue;
            }
            let Ok(parsed) = serde_json::from_str::<Value>(arguments_text) else {
                continue;
            };
            let Some(command) = parsed
                .as_object()
                .and_then(|record| record.get("command"))
                .and_then(Value::as_str)
            else {
                continue;
            };
            let relative = repo_relative(command, repo_dir);
            if excluded_path(&relative)
                || mcp_optimizer_owned(&relative)
                || fixture_command(command)
            {
                continue;
            }
            let key = normalize_command_signature(command, repo_dir);
            if key.is_empty() || is_trivial_command(&key) {
                continue;
            }
            found.push(Occurrence {
                key,
                kind: FamilyKind::Command,
                at: retry.at,
                session: session.id.clone(),
                fragment: format!("retry ×{}", retry.count),
                excerpt: excerpt_of(command, "error", "", &session.title),
                excerpt_rank: 0,
                weight: RETRY_WEIGHT,
            });
        }
    }
    found
}

fn day_of(instant: i64) -> String {
    iso(from_millis(instant)).chars().take(10).collect()
}

fn stamps_of(instant: i64) -> String {
    iso(from_millis(instant))
}

struct JournalGroup {
    key: String,
    kind: FamilyKind,
    text: String,
    scopes: BTreeSet<String>,
    records: Vec<(i64, String, String)>,
}

fn journal_families(
    records: &[JournalRecord],
    start: i64,
    end: i64,
    repo_dir: &Path,
) -> Vec<Occurrence> {
    let mut groups: BTreeMap<String, JournalGroup> = BTreeMap::new();
    for record in records {
        if record.kind != "question" && record.kind != "acp-stderr" {
            continue;
        }
        let Some(at) = parse_instant_millis(&record.ts) else {
            continue;
        };
        if at < start || at > end {
            continue;
        }
        let scope = record.scope.clone().unwrap_or_default();
        if scope.is_empty() || mcp_optimizer_owned(&scope) || excluded_path(&scope) {
            continue;
        }
        let text = if record.kind == "question" {
            normalize_session_line(&record.text, Some(repo_dir))
        } else {
            let first = record
                .text
                .split('\n')
                .map(str::trim)
                .find(|line| !line.is_empty())
                .unwrap_or("");
            normalize_session_line(first, Some(repo_dir))
        };
        if text.is_empty() {
            continue;
        }
        let kind = if record.kind == "question" {
            FamilyKind::Question
        } else {
            FamilyKind::RunFailure
        };
        let key = bound(&format!("{}: {}", kind.as_str(), text), EXCERPT_COMMAND_MAX);
        let group = groups.entry(key.clone()).or_insert_with(|| JournalGroup {
            key,
            kind,
            text: text.clone(),
            scopes: BTreeSet::new(),
            records: Vec::new(),
        });
        group.scopes.insert(scope.clone());
        group.records.push((at, scope, text));
    }
    let mut found = Vec::new();
    for group in groups.values() {
        if group.scopes.len() < 2 {
            continue;
        }
        for (at, scope, text) in &group.records {
            found.push(Occurrence {
                key: group.key.clone(),
                kind: group.kind,
                at: *at,
                session: scope.clone(),
                fragment: group.text.clone(),
                excerpt: excerpt_of(&group.text, "n/a", text, &format!("scope {scope}")),
                excerpt_rank: 0,
                weight: 1,
            });
        }
    }
    found
}

struct Builder {
    key: String,
    kind: FamilyKind,
    calls: i64,
    sessions: BTreeSet<String>,
    days: BTreeSet<String>,
    first: i64,
    last: i64,
    fragments: HashMap<String, i64>,
    excerpts: Vec<(u8, i64, FamilyExcerpt)>,
}

fn to_family(builder: &Builder) -> Family {
    let mut fragments: Vec<FamilyFragment> = builder
        .fragments
        .iter()
        .map(|(text, count)| FamilyFragment {
            text: bound(&collapse_whitespace(text), EXCERPT_COMMAND_MAX),
            count: *count,
        })
        .collect();
    fragments.sort_by(|left, right| {
        right
            .count
            .cmp(&left.count)
            .then_with(|| left.text.cmp(&right.text))
    });
    let mut excerpts = builder.excerpts.clone();
    excerpts.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| left.1.cmp(&right.1))
            .then_with(|| left.2.command.cmp(&right.2.command))
    });
    let excerpts: Vec<FamilyExcerpt> = excerpts
        .into_iter()
        .take(FAMILY_EXCERPT_LIMIT)
        .map(|(_, _, excerpt)| excerpt)
        .collect();
    let sessions: Vec<String> = builder.sessions.iter().cloned().collect();
    let days = builder.days.len();
    let score = (sessions.len() as i64) * (days as i64) * builder.calls;
    Family {
        key: builder.key.clone(),
        kind: builder.kind,
        calls: builder.calls,
        sessions,
        days,
        first_at: stamps_of(builder.first),
        last_at: stamps_of(builder.last),
        score,
        fragments,
        excerpts,
    }
}

/// Groups the window's evidence into families, scores them, and selects the
/// highest-scoring at most 20. Ties break by key ascending; identical evidence
/// and clock produce identical families in identical order.
pub fn build_families(
    sessions: &[Session],
    journal: &[JournalRecord],
    window_start: i64,
    window_end: i64,
    repo_dir: &Path,
) -> FamilySelection {
    let mut builders: BTreeMap<String, Builder> = BTreeMap::new();
    let mut all = occurrences(sessions, window_start, window_end, repo_dir);
    all.extend(journal_families(
        journal,
        window_start,
        window_end,
        repo_dir,
    ));
    for occurrence in all {
        let builder = builders
            .entry(occurrence.key.clone())
            .or_insert_with(|| Builder {
                key: occurrence.key.clone(),
                kind: occurrence.kind,
                calls: 0,
                sessions: BTreeSet::new(),
                days: BTreeSet::new(),
                first: occurrence.at,
                last: occurrence.at,
                fragments: HashMap::new(),
                excerpts: Vec::new(),
            });
        builder.calls += occurrence.weight;
        builder.sessions.insert(occurrence.session.clone());
        builder.days.insert(day_of(occurrence.at));
        if occurrence.at < builder.first {
            builder.first = occurrence.at;
        }
        if occurrence.at > builder.last {
            builder.last = occurrence.at;
        }
        *builder
            .fragments
            .entry(occurrence.fragment.clone())
            .or_insert(0) += 1;
        builder
            .excerpts
            .push((occurrence.excerpt_rank, occurrence.at, occurrence.excerpt));
    }
    let mut families: Vec<Family> = builders.values().map(to_family).collect();
    families.sort_by(|left, right| left.key.cmp(&right.key));
    let mut selected = families.clone();
    selected.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.key.cmp(&right.key))
    });
    selected.truncate(MAX_SELECTED_FAMILIES);
    let omitted = families.len().saturating_sub(selected.len());
    FamilySelection {
        families,
        selected,
        omitted,
    }
}

// ---------------------------------------------------------------------------
// Evidence collection

/// Journal kinds an MCP optimizer cycle keeps.
pub const MCP_OPTIMIZER_JOURNAL_KINDS: &[&str] = &[
    "question",
    "acp-stderr",
    "activity",
    "run-start",
    "run-stop",
];

/// One cycle's evidence. Sessions come from the shared ACP transcript reader;
/// journal records come from the same reader the watchdog uses, so a rotation
/// de-duplicates the same way.
#[derive(Clone, Debug, Default)]
pub struct Collection {
    pub window_start: String,
    pub window_end: String,
    pub sessions: Vec<Session>,
    pub journal: Vec<JournalRecord>,
    pub session_files: usize,
    pub sessions_omitted: usize,
    pub truncated: bool,
    pub skipped: usize,
    pub malformed: usize,
    pub journal_records: usize,
}

/// The journal file names of one project: rotated journals oldest first, then
/// the live file.
fn journal_files(live_path: &Path, since: i64) -> Vec<PathBuf> {
    static NAME: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"^([0-9a-f]{24})\.jsonl(?:\.(\d+)-(\d+))?$").expect("a journal regex")
    });
    let live_name = live_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let Some(live_key) = NAME
        .captures(&live_name)
        .and_then(|captures| captures.get(1))
        .map(|key| key.as_str().to_string())
    else {
        return vec![live_path.to_path_buf()];
    };
    let Some(directory) = live_path.parent() else {
        return vec![live_path.to_path_buf()];
    };
    let Ok(entries) = std::fs::read_dir(directory) else {
        return vec![live_path.to_path_buf()];
    };
    let mut rotated: Vec<(i64, u64, String, PathBuf)> = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(captures) = NAME.captures(&name) else {
            continue;
        };
        let (Some(key), Some(instant), Some(counter)) =
            (captures.get(1), captures.get(2), captures.get(3))
        else {
            continue;
        };
        if key.as_str() != live_key {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if file_mtime_ms(&metadata) < since {
            continue;
        }
        rotated.push((
            instant.as_str().parse().unwrap_or(0),
            counter.as_str().parse().unwrap_or(0),
            name,
            entry.path(),
        ));
    }
    rotated.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| left.1.cmp(&right.1))
            .then_with(|| left.2.cmp(&right.2))
    });
    let mut files: Vec<PathBuf> = rotated.into_iter().map(|(_, _, _, path)| path).collect();
    files.push(live_path.to_path_buf());
    files
}

struct JournalFileEvidence {
    events: Vec<JournalRecord>,
    identities: Vec<String>,
    malformed: usize,
}

fn read_journal_file(path: &Path, start: i64, end: i64) -> JournalFileEvidence {
    let Ok(source) = std::fs::read_to_string(path) else {
        return JournalFileEvidence {
            events: Vec::new(),
            identities: Vec::new(),
            malformed: 0,
        };
    };
    let mut events = Vec::new();
    let mut identities = Vec::new();
    let mut malformed = 0;
    for line in source.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(line) else {
            malformed += 1;
            continue;
        };
        let Some(record) = parsed.as_object() else {
            malformed += 1;
            continue;
        };
        let Some(instant) = record
            .get("ts")
            .and_then(Value::as_str)
            .and_then(parse_instant_millis)
        else {
            malformed += 1;
            continue;
        };
        if instant < start || instant > end {
            continue;
        }
        let Some(kind) = record.get("kind").and_then(Value::as_str) else {
            continue;
        };
        if !crate::journal::JOURNAL_KINDS.contains(&kind) {
            continue;
        }
        let Some(text) = record.get("text").and_then(Value::as_str) else {
            continue;
        };
        let scope = record
            .get("scope")
            .and_then(Value::as_str)
            .filter(|scope| !scope.is_empty())
            .map(str::to_string);
        events.push(JournalRecord {
            kind: kind.to_string(),
            ts: iso(from_millis(instant)),
            text: text.to_string(),
            scope: scope.clone(),
        });
        identities.push(crate::jsjson::stringify(&json!([
            instant,
            kind,
            scope.unwrap_or_default(),
            text
        ])));
    }
    JournalFileEvidence {
        events,
        identities,
        malformed,
    }
}

/// Reads one project's JSONL journal, live and rotated. A record present in
/// both a rotated file and the live one is counted once.
fn read_journal_evidence(
    state_dir: &Path,
    repo_dir: &Path,
    start: i64,
    end: i64,
) -> (Vec<JournalRecord>, usize) {
    let live = crate::journal::journal_file(state_dir, repo_dir);
    let mut events = Vec::new();
    let mut malformed = 0;
    let mut seen: HashMap<String, usize> = HashMap::new();
    for path in journal_files(&live, start) {
        let file = read_journal_file(&path, start, end);
        malformed += file.malformed;
        let mut occurrences: HashMap<String, usize> = HashMap::new();
        for (index, event) in file.events.iter().enumerate() {
            let identity = file.identities.get(index).cloned().unwrap_or_default();
            let occurrence = occurrences.entry(identity.clone()).or_insert(0);
            *occurrence += 1;
            if *occurrence <= seen.get(&identity).copied().unwrap_or(0) {
                continue;
            }
            events.push(event.clone());
        }
        for (identity, count) in occurrences {
            let entry = seen.entry(identity).or_insert(0);
            *entry = (*entry).max(count);
        }
    }
    (events, malformed)
}

/// Collects the evidence for one cycle; it never writes and never spawns.
pub fn collect_evidence(
    state_dir: &Path,
    repo_dir: &Path,
    window_start: OffsetDateTime,
    window_end: OffsetDateTime,
) -> Collection {
    let start = epoch_millis(window_start);
    let end = epoch_millis(window_end);
    let selection = select_sessions(state_dir, repo_dir, Some(start), None);
    let (records, journal_malformed) = read_journal_evidence(state_dir, repo_dir, start, end);
    let mut journal: Vec<JournalRecord> = records
        .into_iter()
        .filter(|record| MCP_OPTIMIZER_JOURNAL_KINDS.contains(&record.kind.as_str()))
        .filter_map(|record| {
            parse_instant_millis(&record.ts)?;
            Some(record)
        })
        .collect();
    journal.sort_by(|left, right| {
        left.ts
            .cmp(&right.ts)
            .then_with(|| left.kind.cmp(&right.kind))
            .then_with(|| {
                left.scope
                    .clone()
                    .unwrap_or_default()
                    .cmp(&right.scope.clone().unwrap_or_default())
            })
            .then_with(|| left.text.cmp(&right.text))
    });
    Collection {
        window_start: iso(window_start),
        window_end: iso(window_end),
        journal_records: journal.len(),
        journal,
        sessions: selection.sessions,
        session_files: selection.selected,
        sessions_omitted: selection.omitted,
        truncated: selection.truncated,
        skipped: selection.skipped,
        malformed: selection.malformed + journal_malformed,
    }
}

// ---------------------------------------------------------------------------
// The read-only status the dashboard serves

#[derive(Clone, Debug, PartialEq)]
pub struct StatusIssue {
    pub url: String,
    pub family: String,
    /// The exact title the filed issue carries.
    pub title: String,
    pub kind: FamilyKind,
    pub filed_at: String,
}

/// The newest cycle, the filed families, the pending depth, and the retained
/// cycle history. It never carries an environment value.
#[derive(Clone, Debug)]
pub struct Status {
    pub cycle: Option<String>,
    pub action: String,
    pub reason: Option<String>,
    pub families: u64,
    pub selected: usize,
    pub filed: usize,
    pub dropped: u64,
    pub pending: usize,
    pub issues: Vec<StatusIssue>,
    pub cycles: Vec<Value>,
}

impl Status {
    pub fn to_json(&self) -> Value {
        let mut record = Map::new();
        record.insert(
            "cycle".into(),
            self.cycle.clone().map(Value::from).unwrap_or(Value::Null),
        );
        record.insert("action".into(), Value::from(self.action.clone()));
        if let Some(reason) = &self.reason {
            record.insert("reason".into(), Value::from(reason.clone()));
        }
        record.insert("families".into(), Value::from(self.families));
        record.insert("selected".into(), Value::from(self.selected as u64));
        record.insert("filed".into(), Value::from(self.filed as u64));
        record.insert("dropped".into(), Value::from(self.dropped));
        record.insert("pending".into(), Value::from(self.pending as u64));
        record.insert(
            "issues".into(),
            Value::Array(
                self.issues
                    .iter()
                    .map(|issue| {
                        json!({
                            "url": issue.url,
                            "family": issue.family,
                            "title": issue.title,
                            "kind": issue.kind.as_str(),
                            "filedAt": issue.filed_at,
                        })
                    })
                    .collect(),
            ),
        );
        record.insert("cycles".into(), Value::Array(self.cycles.clone()));
        Value::Object(record)
    }
}

const CYCLE_HISTORY_LIMIT: usize = 100;

fn cycle_from_report(value: &Value, resolve: &dyn Fn(&str) -> Option<String>) -> Option<Value> {
    let report = value.as_object()?;
    let cycle = report.get("cycle")?.as_str()?;
    if cycle.is_empty() {
        return None;
    }
    let window = report.get("window").and_then(Value::as_object);
    let mut issues: Vec<String> = Vec::new();
    if let Some(findings) = report.get("findings").and_then(Value::as_array) {
        for finding in findings {
            let Some(fingerprint) = finding
                .as_object()
                .and_then(|entry| entry.get("fingerprint"))
                .and_then(Value::as_str)
            else {
                continue;
            };
            if let Some(url) = resolve(fingerprint) {
                if !url.is_empty() && !issues.contains(&url) {
                    issues.push(url);
                }
            }
        }
    }
    if let Some(filed) = report.get("issues").and_then(Value::as_array) {
        for issue in filed {
            if let Some(url) = issue
                .as_object()
                .and_then(|entry| entry.get("url"))
                .and_then(Value::as_str)
            {
                if !url.is_empty() && !issues.contains(&url.to_string()) {
                    issues.push(url.to_string());
                }
            }
        }
    }
    let mut row = Map::new();
    row.insert("at".into(), Value::from(cycle));
    row.insert(
        "window".into(),
        json!({
            "start": window.and_then(|window| window.get("start")).and_then(Value::as_str),
            "end": window.and_then(|window| window.get("end")).and_then(Value::as_str),
        }),
    );
    row.insert(
        "action".into(),
        Value::from(
            report
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("none"),
        ),
    );
    row.insert(
        "findings".into(),
        Value::from(
            report
                .get("findings")
                .and_then(Value::as_array)
                .map(|findings| findings.len() as u64)
                .unwrap_or(0),
        ),
    );
    row.insert(
        "issues".into(),
        Value::Array(issues.into_iter().map(Value::from).collect()),
    );
    if let Some(reason) = report.get("reason").and_then(Value::as_str) {
        row.insert("reason".into(), Value::from(reason));
    }
    Some(Value::Object(row))
}

/// The newest-first cycle history: one row per run directory, capped at 100.
fn read_cycles(directory: &Path, latest: Option<&Value>) -> Vec<Value> {
    let resolve = |_fingerprint: &str| -> Option<String> { None };
    let runs = runs_directory(directory);
    let mut names: Vec<String> = std::fs::read_dir(&runs)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
                .filter_map(|entry| entry.file_name().into_string().ok())
                .collect()
        })
        .unwrap_or_default();
    if names.is_empty() {
        return latest
            .and_then(|value| cycle_from_report(value, &resolve))
            .into_iter()
            .collect();
    }
    names.sort_by(|left, right| right.cmp(left));
    names.truncate(CYCLE_HISTORY_LIMIT);
    names
        .into_iter()
        .filter_map(|name| {
            let report = read_json(&runs.join(name).join("report.json"))?;
            cycle_from_report(&report, &resolve)
        })
        .collect()
}

pub fn read_status(directory: &Path) -> Status {
    let latest_value = read_json(&latest_path(directory)).filter(Value::is_object);
    let latest = latest_value.as_ref().and_then(Value::as_object);
    let ledger = load_ledger(directory).ledger;
    let mut issues: Vec<StatusIssue> = ledger
        .families
        .iter()
        .filter_map(|(family, entry)| {
            let url = entry.last_issue_url.clone()?;
            Some(StatusIssue {
                url,
                family: family.clone(),
                title: entry
                    .last_title
                    .clone()
                    .unwrap_or_else(|| format!("[mcp-optimizer] {family}")),
                kind: entry.kind,
                filed_at: entry
                    .last_filed_at
                    .clone()
                    .unwrap_or_else(|| entry.last_seen.clone()),
            })
        })
        .collect();
    issues.sort_by(|left, right| {
        right
            .filed_at
            .cmp(&left.filed_at)
            .then_with(|| left.url.cmp(&right.url))
    });
    Status {
        cycle: latest
            .and_then(|record| record.get("cycle"))
            .and_then(Value::as_str)
            .map(str::to_string),
        action: latest
            .and_then(|record| record.get("action"))
            .and_then(Value::as_str)
            .unwrap_or("none")
            .to_string(),
        reason: latest
            .and_then(|record| record.get("reason"))
            .and_then(Value::as_str)
            .map(str::to_string),
        families: latest
            .and_then(|record| record.get("families"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        selected: latest
            .and_then(|record| record.get("selected"))
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0),
        filed: latest
            .and_then(|record| record.get("issues"))
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0),
        dropped: latest
            .and_then(|record| record.get("dropped"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        pending: ledger.pending_filing.len(),
        issues,
        cycles: read_cycles(directory, latest_value.as_ref()),
    }
}

// ---------------------------------------------------------------------------
// Synthesis

pub const SYNTHESIS_TIMEOUT_MS: u64 = 120_000;
pub const SYNTHESIS_CONCURRENCY: usize = 4;
pub const SYNTHESIS_PROMPT_MAX_BYTES: usize = 24 * 1024;
/// Verification seam: a JSON file that answers every synthesis call.
pub const SYNTHESIS_STUB_ENV: &str = "DEVBOARD_MCP_OPTIMIZER_SYNTHESIS_STUB";
/// What the template states when no successful open-issue read is available.
pub const MCP_OPTIMIZER_PROMPT_ISSUES_UNAVAILABLE: &str =
    "Open MCP optimizer issues could not be read.";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SynthesisResult {
    pub ok: bool,
    pub model: String,
    pub duration_ms: u64,
    pub text: Option<String>,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SynthesisPaths {
    /// The MCP tool log for this family's issue-creation calls.
    pub tool_log_path: PathBuf,
    /// The MCP skip log for this family's recorded no-proposal reason.
    pub skip_log_path: PathBuf,
}

pub type SynthesisFuture = Pin<Box<dyn Future<Output = SynthesisResult> + Send>>;
/// The coordinator's synthesis call, injectable for tests.
pub type Synthesize = Arc<dyn Fn(Family, String, SynthesisPaths) -> SynthesisFuture + Send + Sync>;

struct PromptSections {
    family: String,
    fragments: String,
    excerpts: String,
    catalog: String,
    issues: String,
    allowlist: String,
    limits: String,
}

/// Every fixed line and dynamic section of the one synthesis prompt.
fn prompt_text(sections: &PromptSections) -> String {
    [
        "## Manifesto".to_string(),
        String::new(),
        "You are the Devboard MCP optimizer synthesizer for one family. Your goal is to remove the".to_string(),
        "recurring friction this family evidences, and your observable result is at most one proposal".to_string(),
        "issue filed through the Devboard MCP issue tool, or one recorded reason the family needs no".to_string(),
        "issue.".to_string(),
        String::new(),
        "Read this family's evidence, read the open MCP optimizer issues yourself, then act. Never".to_string(),
        "answer with a JSON document, fragment, diff, or summary.".to_string(),
        String::new(),
        "Family:".to_string(),
        sections.family.clone(),
        String::new(),
        "Fragments:".to_string(),
        sections.fragments.clone(),
        String::new(),
        "Excerpts:".to_string(),
        sections.excerpts.clone(),
        String::new(),
        "MCP catalog:".to_string(),
        sections.catalog.clone(),
        String::new(),
        "Open MCP optimizer issues:".to_string(),
        sections.issues.clone(),
        String::new(),
        "Command allowlist:".to_string(),
        sections.allowlist.clone(),
        String::new(),
        "Limits:".to_string(),
        sections.limits.clone(),
        String::new(),
        "Rules:".to_string(),
        "- Read the open issues with `issues_list` and `issue_get`. A proposal duplicates an open".to_string(),
        "  issue when that issue carries this family's tag or the same title. A duplicate files and".to_string(),
        "  comments on nothing.".to_string(),
        "- File at most one issue for this family, and only when `filingRoom` is greater than zero.".to_string(),
        "- Prefer the smaller change: \"tool\" when a stable named capability removes the recurrence,".to_string(),
        "  \"prompt\" when one instruction is enough.".to_string(),
        "- A tool proposal names a capability, not a wrapper around this one command. Never reuse a".to_string(),
        "  name from the catalog. `covers` entries are the normalized command prefixes the tool".to_string(),
        "  replaces; at least one must match the family key. The family must be covered by the".to_string(),
        "  command allowlist; the body carries the exact allowlist entry to add.".to_string(),
        "- A prompt proposal names one instruction and a target under `.devboard/prompts/` or an".to_string(),
        "  agent id.".to_string(),
        "- The issue title is exactly `[mcp-optimizer] <family key>` for a tool proposal or".to_string(),
        "  `[mcp-optimizer] prompt: <family key>` for a prompt proposal.".to_string(),
        "- The issue body has exactly these level-two sections in order: `## Family`,".to_string(),
        "  `## Evidence`, `## Proposed tool` or `## Proposed prompt`, `## Acceptance`, `## Rationale`.".to_string(),
        "  `## Family` states the key, kind, call and session counts, first and last timestamps,".to_string(),
        "  and the family tag. `## Evidence` carries the fragments and the excerpts. `## Acceptance`".to_string(),
        "  carries one to five `- [ ]` criteria checkable from the evidence.".to_string(),
        "- File with `issue_create` and no labels. Its returned number and URL are the record.".to_string(),
        "- When the family needs no change, a duplicate exists, a cap leaves no room, or filing".to_string(),
        "  fails, call `mcp_optimizer_proposal_skip` with the family key and one reason sentence.".to_string(),
        "  Call either `issue_create` or `mcp_optimizer_proposal_skip` for this family, never both.".to_string(),
        String::new(),
    ]
    .join("\n")
}

/// The catalog JSON every prompt carries: name/title pairs in catalog order.
fn catalog_json() -> String {
    let payload = crate::mcp::tool_list_payload();
    let tools = payload
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let names: Vec<Value> = tools
        .iter()
        .map(|tool| {
            json!({
                "name": tool.get("name").cloned().unwrap_or(Value::Null),
                "title": tool.get("title").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    let mut covers: BTreeSet<String> = BTreeSet::new();
    for tool in &tools {
        if let Some(entries) = tool.get("covers").and_then(Value::as_array) {
            for entry in entries {
                if let Some(entry) = entry.as_str() {
                    covers.insert(entry.to_string());
                }
            }
        }
    }
    let covers: Vec<String> = covers.into_iter().collect();
    pretty_json(&json!({ "tools": names, "covers": covers }))
}

fn pretty_json(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".to_string())
}

/// The three fields of one open issue the prompt publishes.
fn issue_rows(issues: &[OpenIssue]) -> Value {
    Value::Array(
        issues
            .iter()
            .map(|issue| {
                json!({
                    "number": issue.number,
                    "title": issue.title,
                    "url": issue.url,
                })
            })
            .collect(),
    )
}

/// The open issues one synthesis call sees.
pub fn mcp_optimizer_issues(issues: &[OpenIssue]) -> Vec<OpenIssue> {
    issues
        .iter()
        .filter(|issue| {
            issue.title.starts_with("[mcp-optimizer]") || issue.body.contains("family:")
        })
        .cloned()
        .collect()
}

fn family_json(family: &Family) -> Value {
    json!({
        "key": family.key,
        "kind": family.kind.as_str(),
        "calls": family.calls,
        "sessions": family.sessions.len(),
        "days": family.days,
        "first_at": family.first_at,
        "last_at": family.last_at,
        "tag": format!("family:{}", family_tag(&family.key)),
    })
}

fn excerpts_json(excerpts: &[FamilyExcerpt]) -> String {
    pretty_json(&Value::Array(
        excerpts
            .iter()
            .map(|excerpt| {
                json!({
                    "command": excerpt.command,
                    "status": excerpt.status,
                    "output": excerpt.output,
                    "sessionTitle": excerpt.session_title,
                })
            })
            .collect(),
    ))
}

fn fragments_json(fragments: &[FamilyFragment]) -> String {
    pretty_json(&Value::Array(
        fragments
            .iter()
            .map(|fragment| json!({ "text": fragment.text, "count": fragment.count }))
            .collect(),
    ))
}

fn utf16_units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// The first `units` UTF-16 code units of `text`, never splitting a surrogate
/// pair.
fn prefix_of(text: &str, units: usize) -> String {
    let encoded = utf16_units(text);
    if units >= encoded.len() {
        return text.to_string();
    }
    let mut end = units;
    if end > 0 && (0xD800..=0xDBFF).contains(&encoded[end - 1]) {
        end -= 1;
    }
    String::from_utf16_lossy(&encoded[..end])
}

/// The marker a cut fragment string ends with, so the cut is visible.
const FRAGMENT_CUT_MARKER: &str = "…";

/// One fragment whose text is cut to the longest prefix that still fits beside
/// `kept`, or `None` when not even the marker fits.
fn cut_fragment_json(
    fragment: &FamilyFragment,
    kept: &[FamilyFragment],
    allowance: usize,
) -> Option<String> {
    let render = |units: usize| -> Option<String> {
        let mut entries: Vec<Value> = kept
            .iter()
            .map(|entry| json!({ "text": entry.text, "count": entry.count }))
            .collect();
        entries.push(json!({
            "text": format!("{}{}", prefix_of(&fragment.text, units), FRAGMENT_CUT_MARKER),
            "count": fragment.count,
        }));
        let text = pretty_json(&Value::Array(entries));
        (text.len() <= allowance).then_some(text)
    };
    let mut best = render(0);
    let mut low = 0_usize;
    let mut high = utf16_len(&fragment.text);
    while low <= high {
        let mid = (low + high) / 2;
        match render(mid) {
            Some(candidate) => {
                best = Some(candidate);
                low = mid + 1;
            }
            None => {
                if mid == 0 {
                    break;
                }
                high = mid - 1;
            }
        }
    }
    best
}

/// The fragments section, bounded to `allowance` UTF-8 bytes.
fn bounded_fragments_json(fragments: &[FamilyFragment], allowance: usize) -> String {
    let mut ordered = fragments.to_vec();
    ordered.sort_by(|left, right| {
        right
            .count
            .cmp(&left.count)
            .then_with(|| left.text.cmp(&right.text))
    });
    let mut kept: Vec<FamilyFragment> = Vec::new();
    let mut text = fragments_json(&kept);
    for fragment in ordered {
        let mut next = kept.clone();
        next.push(fragment.clone());
        let next_text = fragments_json(&next);
        if next_text.len() > allowance {
            return cut_fragment_json(&fragment, &kept, allowance).unwrap_or(text);
        }
        kept = next;
        text = next_text;
    }
    text
}

fn render_prompt(
    family: &Family,
    excerpts: &[FamilyExcerpt],
    issues: &[OpenIssue],
    settings: &Settings,
    filing_room: i64,
    fragments: &str,
) -> String {
    prompt_text(&PromptSections {
        family: pretty_json(&family_json(family)),
        fragments: fragments.to_string(),
        excerpts: excerpts_json(excerpts),
        catalog: catalog_json(),
        issues: pretty_json(&issue_rows(issues)),
        allowlist: pretty_json(&json!(settings.allowlist)),
        limits: pretty_json(&json!({
            "maxIssuesPerCycle": settings.max_issues_per_cycle,
            "maxPerHour": settings.max_per_hour,
            "maxPending": settings.max_pending,
            "filingRoom": filing_room,
        })),
    })
}

/// The prompt. It carries one family's summary, fragments, at most five
/// excerpts, the catalog, every open MCP optimizer issue, the configured
/// allowlist, and the cycle's filing room. Identical family and settings bytes
/// produce an identical prompt.
pub fn synthesis_prompt(
    family: &Family,
    settings: &Settings,
    open_issues: &[OpenIssue],
    filing_room: i64,
) -> String {
    let mut excerpts = family.excerpts.clone();
    let mut issues: Vec<OpenIssue> = open_issues.to_vec();
    issues.sort_by_key(|issue| issue.number);
    let fragments = fragments_json(&family.fragments);
    let mut text = render_prompt(
        family,
        &excerpts,
        &issues,
        settings,
        filing_room,
        &fragments,
    );
    while text.len() >= SYNTHESIS_PROMPT_MAX_BYTES {
        if !excerpts.is_empty() {
            excerpts.pop();
        } else if issues.len() > 1 {
            issues.pop();
        } else {
            // Evidence shrinks; the filing contract never does.
            let empty = render_prompt(family, &excerpts, &issues, settings, filing_room, "");
            let allowance = SYNTHESIS_PROMPT_MAX_BYTES
                .saturating_sub(1)
                .saturating_sub(empty.len());
            let bounded = bounded_fragments_json(&family.fragments, allowance);
            text = render_prompt(family, &excerpts, &issues, settings, filing_room, &bounded);
            break;
        }
        text = render_prompt(
            family,
            &excerpts,
            &issues,
            settings,
            filing_room,
            &fragments,
        );
    }
    text
}

/// The read-only template the MCP optimizer page shows, with the per-family
/// sections named as placeholders.
pub fn prompt_template(settings: &Settings, open_issues: Option<&[OpenIssue]>) -> String {
    let issues = match open_issues {
        None => MCP_OPTIMIZER_PROMPT_ISSUES_UNAVAILABLE.to_string(),
        Some(open) => {
            let mut filtered = mcp_optimizer_issues(open);
            filtered.sort_by_key(|issue| issue.number);
            pretty_json(&issue_rows(&filtered))
        }
    };
    prompt_text(&PromptSections {
        family: "<family>".to_string(),
        fragments: "<fragments>".to_string(),
        excerpts: "<excerpts>".to_string(),
        catalog: catalog_json(),
        issues,
        allowlist: pretty_json(&json!(settings.allowlist)),
        limits: pretty_json(&json!({
            "maxIssuesPerCycle": settings.max_issues_per_cycle,
            "maxPerHour": settings.max_per_hour,
            "maxPending": settings.max_pending,
            "filingRoom": "<filingRoom>",
        })),
    })
}

fn substitute_family(value: &Value, family: &str) -> Value {
    match value {
        Value::String(text) => Value::String(text.replace("{{family}}", family)),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| substitute_family(item, family))
                .collect(),
        ),
        Value::Object(record) => Value::Object(
            record
                .iter()
                .map(|(key, entry)| (key.clone(), substitute_family(entry, family)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Reads the verification stub and returns a peer replacement that performs
/// the same tool writes a real peer would.
pub fn read_synthesis_stub(
    path: &Path,
    family: &str,
    paths: &SynthesisPaths,
) -> anyhow::Result<
    impl Fn(String) -> Pin<Box<dyn Future<Output = anyhow::Result<String>> + Send>>
        + Send
        + Sync
        + 'static,
> {
    let text = std::fs::read_to_string(path)
        .map_err(|error| anyhow::anyhow!("the synthesis stub could not be read: {error}"))?;
    let parsed: Value = serde_json::from_str(&text)
        .map_err(|error| anyhow::anyhow!("the synthesis stub could not be read: {error}"))?;
    if !parsed.is_object() {
        anyhow::bail!("the synthesis stub is not an object");
    }
    let answer = parsed
        .get("families")
        .and_then(Value::as_object)
        .and_then(|families| families.get(family))
        .or_else(|| parsed.get("default"))
        .cloned();
    let error = parsed
        .get("error")
        .and_then(Value::as_str)
        .map(str::to_string);
    let family = family.to_string();
    let paths = paths.clone();
    Ok(move |_prompt: String| {
        let family = family.clone();
        let paths = paths.clone();
        let answer = answer.clone();
        let error = error.clone();
        let future: Pin<Box<dyn Future<Output = anyhow::Result<String>> + Send>> =
            Box::pin(async move {
                if let Some(error) = error {
                    anyhow::bail!(error);
                }
                let Some(answer) = answer else {
                    anyhow::bail!("the synthesis stub has no answer for the family");
                };
                let entry = substitute_family(&answer, &family);
                let record = entry.as_object().cloned().unwrap_or_default();
                let action = record.get("action").and_then(Value::as_str).unwrap_or("");
                if action == "tool" || action == "prompt" {
                    let title = record
                        .get("title")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("[mcp-optimizer] {family}"));
                    let _body = record
                        .get("body")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let number = record.get("number").and_then(Value::as_u64).unwrap_or(1);
                    let url = record
                        .get("url")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| {
                            format!("https://forge.test/fixture/fixture/issues/{number}")
                        });
                    let line = format!(
                        "{}\n",
                        crate::jsjson::stringify(&json!({
                            "tool": "issue_create",
                            "at": now_iso(),
                            "ok": true,
                            "value": { "number": number, "url": url, "title": title, "labels": [] },
                        }))
                    );
                    std::fs::write(&paths.tool_log_path, line)?;
                    return Ok(String::new());
                }
                let reason = record
                    .get("reason")
                    .and_then(Value::as_str)
                    .filter(|reason| !reason.is_empty())
                    .unwrap_or("the family needs no proposal");
                let line = format!(
                    "{}\n",
                    crate::jsjson::stringify(&json!({
                        "tool": "mcp_optimizer_proposal_skip",
                        "at": now_iso(),
                        "ok": true,
                        "value": { "family": family, "status": "skipped", "reason": reason },
                    }))
                );
                std::fs::write(&paths.skip_log_path, line)?;
                Ok(String::new())
            });
        future
    })
}

/// The synthesizer peer bindings: one per enabled OpenCode Go subscription,
/// led by the dashboard's published selection.
pub fn open_code_peers(
    state_dir: &Path,
    environment: &HashMap<String, String>,
) -> Result<Vec<crate::providers::PeerBinding>, String> {
    let loaded = crate::providers::load_subscriptions(state_dir);
    let selection = crate::providers::read_selection_snapshot(state_dir);
    let mut go: Vec<crate::providers::StoredSubscription> = loaded
        .subscriptions
        .iter()
        .filter(|entry| entry.provider == crate::providers::ProviderId::OpenCodeGo && entry.enabled)
        .cloned()
        .collect();
    if let Some(selection) = &selection {
        if selection.provider == crate::providers::ProviderId::OpenCodeGo {
            if let Some(index) = go
                .iter()
                .position(|entry| entry.id == selection.subscription_id)
            {
                let chosen = go.remove(index);
                go.insert(0, chosen);
            }
        }
    }
    if go.is_empty() {
        return Err("the synthesizer has no enabled OpenCode Go subscription".to_string());
    }
    let fallback = loaded
        .subscriptions
        .iter()
        .find(|entry| entry.provider == crate::providers::ProviderId::OpenRouter && entry.enabled)
        .map(|entry| entry.key.clone());
    let base: crate::providers::Env = environment
        .iter()
        .map(|(key, value)| (key.clone(), Some(value.clone())))
        .collect();
    let mut peers = Vec::new();
    for entry in &go {
        let mut binding = crate::providers::PeerBinding {
            provider: crate::providers::ProviderId::OpenCodeGo,
            provider_name: crate::providers::provider_name(
                crate::providers::ProviderId::OpenCodeGo,
            ),
            subscription_id: entry.id.clone(),
            subscription_label: entry.label.clone(),
            model: crate::providers::OPENCODE_GO_MODEL.to_string(),
            remaining_fraction: None,
            agent_dir: crate::providers::agent_directory(
                state_dir,
                crate::providers::ProviderId::OpenCodeGo,
                &entry.id,
            ),
            env: HashMap::new(),
        };
        binding.env =
            crate::providers::peer_environment(&base, &binding, &entry.key, fallback.as_deref());
        let mcp = crate::providers::default_agent_mcp();
        let config = crate::providers::generated_config(
            crate::providers::ProviderId::OpenCodeGo,
            &binding.model,
        );
        if let Err(error) =
            crate::providers::write_agent_directory(&binding.agent_dir, &config, &mcp)
        {
            return Err(format!(
                "the synthesizer agent directory could not be written: {error}"
            ));
        }
        peers.push(binding);
    }
    Ok(peers)
}

struct PeerFailure {
    message: String,
    credential: bool,
}

fn credential_rejection(text: &str) -> bool {
    static PATTERN: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)invalid credential|invalid api key|unauthorized|\b401\b")
            .expect("a credential regex")
    });
    PATTERN.is_match(text)
}

struct SynthesisPeerRun {
    binding: crate::providers::PeerBinding,
    command: String,
    repo_dir: PathBuf,
    prompt: String,
    timeout_ms: u64,
    tool_log_path: Option<PathBuf>,
    skip_log_path: Option<PathBuf>,
}

/// One peer turn. Returns the assistant text and always closes the process.
async fn run_synthesis_peer(run: SynthesisPeerRun) -> Result<String, PeerFailure> {
    let mut environment: HashMap<String, String> = run
        .binding
        .env
        .iter()
        .filter_map(|(key, value)| value.clone().map(|value| (key.clone(), value)))
        .collect();
    if let Some(path) = &run.tool_log_path {
        environment.insert(
            "DEVBOARD_TOOL_LOG".to_string(),
            path.to_string_lossy().into_owned(),
        );
    }
    if let Some(path) = &run.skip_log_path {
        environment.insert(
            "DEVBOARD_MCP_OPTIMIZER_SKIP_LOG".to_string(),
            path.to_string_lossy().into_owned(),
        );
    }
    let options = crate::acp::AcpConnectionOptions::new(
        run.command.clone(),
        run.repo_dir.to_string_lossy().into_owned(),
    )
    .with_env(environment)
    .with_permission_policy(crate::acp::PermissionPolicy::Deny);
    let (connection, mut events) =
        crate::acp::AcpConnection::connect(options)
            .await
            .map_err(|error| PeerFailure {
                message: error.to_string(),
                credential: credential_rejection(&error.to_string()),
            })?;
    let prompt = run.prompt.clone();
    let future = connection.run(&prompt);
    tokio::pin!(future);
    let deadline = tokio::time::Instant::now() + Duration::from_millis(run.timeout_ms);
    let mut text = String::new();
    let mut stderr = String::new();
    loop {
        tokio::select! {
            result = &mut future => {
                return match result {
                    Ok(_) => Ok(text),
                    Err(error) => {
                        let detail = stderr
                            .split('\n')
                            .map(str::trim)
                            .filter(|line| !line.is_empty())
                            .next_back();
                        let message = match detail {
                            Some(detail) => format!("{error} ({detail})"),
                            None => error.to_string(),
                        };
                        let credential = credential_rejection(&message);
                        Err(PeerFailure {
                            message: if credential {
                                format!("the synthesizer key was rejected: {}", first_line(&message))
                            } else {
                                message
                            },
                            credential,
                        })
                    }
                };
            }
            event = events.recv() => {
                match event {
                    Some(crate::acp::AcpEvent::Text(chunk)) => text.push_str(&chunk),
                    Some(crate::acp::AcpEvent::Stderr(chunk)) => {
                        stderr.push_str(&chunk);
                        if stderr.len() > 2_000 {
                            let cut = stderr.len() - 2_000;
                            let boundary = (0..=cut).rev().find(|index| stderr.is_char_boundary(*index)).unwrap_or(0);
                            stderr = stderr[boundary..].to_string();
                        }
                    }
                    Some(crate::acp::AcpEvent::Question(_)) => {
                        connection.close();
                        return Err(PeerFailure {
                            message: "the synthesizer peer asked a question; refusing".to_string(),
                            credential: false,
                        });
                    }
                    Some(_) => {}
                    None => {}
                }
            }
            _ = tokio::time::sleep_until(deadline) => {
                connection.close();
                return Err(PeerFailure {
                    message: format!("the synthesizer peer timed out after {}ms", run.timeout_ms),
                    credential: false,
                });
            }
        }
    }
}

pub struct SynthesizeOptions {
    pub repo_dir: PathBuf,
    pub state_dir: PathBuf,
    pub family: Family,
    pub prompt: String,
    pub environment: HashMap<String, String>,
    pub command: Option<String>,
    pub timeout_ms: Option<u64>,
    pub tool_log_path: Option<PathBuf>,
    pub skip_log_path: Option<PathBuf>,
    /// Test seam: replaces the ACP peer with a deterministic function.
    pub run: Option<
        Arc<
            dyn Fn(String) -> Pin<Box<dyn Future<Output = anyhow::Result<String>> + Send>>
                + Send
                + Sync,
        >,
    >,
}

/// Runs one family's synthesis peer.
pub async fn synthesize_family(options: SynthesizeOptions) -> SynthesisResult {
    let started = std::time::Instant::now();
    if let Some(run) = &options.run {
        return match run(options.prompt.clone()).await {
            Ok(text) => SynthesisResult {
                ok: true,
                text: Some(text),
                model: "stub".to_string(),
                duration_ms: started.elapsed().as_millis() as u64,
                reason: None,
            },
            Err(error) => SynthesisResult {
                ok: false,
                text: None,
                model: "stub".to_string(),
                duration_ms: started.elapsed().as_millis() as u64,
                reason: Some(format!("{error:#}")),
            },
        };
    }
    let peers = match open_code_peers(&options.state_dir, &options.environment) {
        Ok(peers) => peers,
        Err(reason) => {
            return SynthesisResult {
                ok: false,
                model: String::new(),
                duration_ms: 0,
                text: None,
                reason: Some(reason),
            }
        }
    };
    let command = options
        .command
        .clone()
        .or_else(|| options.environment.get("AGENT_COMMAND").cloned())
        .unwrap_or_else(|| "omp acp".to_string());
    let mut last: Option<PeerFailure> = None;
    for (index, binding) in peers.iter().enumerate() {
        let outcome = run_synthesis_peer(SynthesisPeerRun {
            binding: binding.clone(),
            command: command.clone(),
            repo_dir: options.repo_dir.clone(),
            prompt: options.prompt.clone(),
            timeout_ms: options.timeout_ms.unwrap_or(SYNTHESIS_TIMEOUT_MS),
            tool_log_path: options.tool_log_path.clone(),
            skip_log_path: options.skip_log_path.clone(),
        })
        .await;
        match outcome {
            Ok(text) => {
                return SynthesisResult {
                    ok: true,
                    text: Some(text),
                    model: peers[0].model.clone(),
                    duration_ms: started.elapsed().as_millis() as u64,
                    reason: None,
                }
            }
            Err(failure) => {
                if !failure.credential || index == peers.len() - 1 {
                    return SynthesisResult {
                        ok: false,
                        model: peers[0].model.clone(),
                        duration_ms: started.elapsed().as_millis() as u64,
                        text: None,
                        reason: Some(failure.message),
                    };
                }
                last = Some(failure);
            }
        }
    }
    SynthesisResult {
        ok: false,
        model: peers
            .first()
            .map(|peer| peer.model.clone())
            .unwrap_or_default(),
        duration_ms: started.elapsed().as_millis() as u64,
        text: None,
        reason: Some(
            last.map(|failure| failure.message)
                .unwrap_or_else(|| "the synthesizer peer returned no answer".to_string()),
        ),
    }
}

// ---------------------------------------------------------------------------
// Issue delivery

/// One delivery result: the created issue's URL, or the reason it failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DeliveryResult {
    Created { url: String },
    Failed { reason: String },
}

pub type DeliveryFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// MCP optimizer issue delivery. It redacts every unseen secret before the
/// bytes leave the process, and never closes, reopens, renames, or comments on
/// an issue. The deduplication read is the same client: the open issues, with
/// their bodies.
pub trait Delivery: Send + Sync {
    fn repository(&self) -> String;
    /// Every open issue, with the body deduplication reads.
    fn list(&self) -> DeliveryFuture<'_, anyhow::Result<Vec<OpenIssue>>>;
    fn create<'a>(&'a self, title: String, body: String) -> DeliveryFuture<'a, DeliveryResult>;
}

/// A verification run injects this directory: the delivery then records each
/// call in `calls.jsonl`, answers a deterministic issue URL, and lists the
/// issues it created, so no test contacts a real forge.
pub const MCP_OPTIMIZER_FORGE_STUB_ENV: &str = "DEVBOARD_MCP_OPTIMIZER_FORGE_STUB";

struct StubDelivery {
    directory: PathBuf,
    repository: String,
    redact: Arc<dyn Fn(&str) -> String + Send + Sync>,
}

#[derive(Clone)]
struct StubCall {
    title: String,
    body: String,
    url: String,
}

fn read_stub_calls(directory: &Path) -> Vec<StubCall> {
    let Ok(text) = std::fs::read_to_string(directory.join("calls.jsonl")) else {
        return Vec::new();
    };
    text.split('\n')
        .filter_map(|line| {
            if line.trim().is_empty() {
                return None;
            }
            let parsed: Value = serde_json::from_str(line).ok()?;
            let record = parsed.as_object()?;
            if record.get("op").and_then(Value::as_str) != Some("create") {
                return None;
            }
            Some(StubCall {
                title: record
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                body: record
                    .get("body")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                url: record
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            })
        })
        .collect()
}

impl Delivery for StubDelivery {
    fn repository(&self) -> String {
        self.repository.clone()
    }

    fn list(&self) -> DeliveryFuture<'_, anyhow::Result<Vec<OpenIssue>>> {
        let directory = self.directory.clone();
        let repository = self.repository.clone();
        Box::pin(async move {
            Ok(read_stub_calls(&directory)
                .into_iter()
                .enumerate()
                .map(|(index, call)| OpenIssue {
                    number: index as u64 + 1,
                    title: call.title,
                    body: call.body,
                    url: if call.url.is_empty() {
                        format!("https://forge.test/{repository}/issues/{}", index + 1)
                    } else {
                        call.url
                    },
                })
                .collect())
        })
    }

    fn create<'a>(&'a self, title: String, body: String) -> DeliveryFuture<'a, DeliveryResult> {
        Box::pin(async move {
            let title = (self.redact)(&title);
            let body = (self.redact)(&body);
            let directory = self.directory.clone();
            let repository = self.repository.clone();
            let _ = std::fs::create_dir_all(&directory);
            let number = read_stub_calls(&directory).len() + 1;
            let url = format!("https://forge.test/{repository}/issues/{number}");
            let line = format!(
                "{}\n",
                crate::jsjson::stringify(&json!({
                    "op": "create",
                    "title": title,
                    "body": body,
                    "url": url,
                }))
            );
            use std::io::Write;
            let write = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(directory.join("calls.jsonl"))
                .and_then(|mut file| file.write_all(line.as_bytes()));
            match write {
                Ok(()) => DeliveryResult::Created { url },
                Err(error) => DeliveryResult::Failed {
                    reason: error.to_string(),
                },
            }
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ForgeKind {
    GitHub,
    Gitea,
    GitLab,
}

#[derive(Clone, Debug)]
struct OriginRemote {
    forge: ForgeKind,
    host: String,
    project: String,
    origin_url: Option<String>,
}

fn origin_remote_url(repo_dir: &Path) -> Option<String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo_dir)
        .args(["remote", "get-url", "origin"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!url.is_empty()).then_some(url)
}

fn parse_origin_remote(url: &str) -> Option<OriginRemote> {
    let (host, path, scheme) = if let Some(rest) = url.strip_prefix("git@") {
        let (host, path) = rest.split_once(':')?;
        (host.to_string(), path.to_string(), None)
    } else if let Some(rest) = url.strip_prefix("ssh://") {
        let rest = rest.split_once('@').map(|(_, rest)| rest).unwrap_or(rest);
        let (host, path) = rest.split_once('/')?;
        (host.to_string(), format!("/{path}"), None)
    } else {
        let parsed = url::Url::parse(url).ok()?;
        let host = parsed.host_str()?.to_string();
        let origin = Some(parsed.origin().ascii_serialization());
        (host, parsed.path().to_string(), origin)
    };
    let project = path
        .trim_start_matches('/')
        .trim_end_matches('/')
        .strip_suffix(".git")
        .unwrap_or_else(|| path.trim_start_matches('/').trim_end_matches('/'))
        .to_string();
    if project.split('/').count() < 2 {
        return None;
    }
    let forge = if host == "github.com" || host.ends_with(".github.com") {
        ForgeKind::GitHub
    } else if host == "gitlab.com" || host.contains("gitlab") {
        ForgeKind::GitLab
    } else {
        ForgeKind::Gitea
    };
    Some(OriginRemote {
        forge,
        host,
        project,
        origin_url: scheme,
    })
}

fn origin_remote(repo_dir: &Path) -> Option<OriginRemote> {
    parse_origin_remote(&origin_remote_url(repo_dir)?)
}

fn environment_pairs(environment: &HashMap<String, String>) -> Vec<(String, String)> {
    environment
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

fn provider_secrets(state_dir: &Path) -> Vec<String> {
    crate::providers::load_subscriptions(state_dir)
        .subscriptions
        .iter()
        .map(|entry| entry.key.clone())
        .collect()
}

struct NativeDelivery {
    origin: OriginRemote,
    repository: String,
    environment: HashMap<String, String>,
    redact: Arc<dyn Fn(&str) -> String + Send + Sync>,
}

fn gh_command(
    environment: &HashMap<String, String>,
    args: &[&str],
) -> std::io::Result<std::process::Output> {
    let mut command = std::process::Command::new("gh");
    command.args(args);
    command.env_clear();
    for (key, value) in environment {
        command.env(key, value);
    }
    command.output()
}

impl NativeDelivery {
    async fn list_github(&self) -> anyhow::Result<Vec<OpenIssue>> {
        let output = gh_command(
            &self.environment,
            &[
                "issue",
                "list",
                "--state",
                "open",
                "--limit",
                "100",
                "--json",
                "number,title,body,url",
            ],
        )?;
        if !output.status.success() {
            anyhow::bail!(first_line(&String::from_utf8_lossy(&output.stderr)));
        }
        let parsed: Value = serde_json::from_slice(&output.stdout)
            .map_err(|error| anyhow::anyhow!("the open issues could not be read: {error}"))?;
        let issues = parsed
            .as_array()
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|entry| {
                        let record = entry.as_object()?;
                        Some(OpenIssue {
                            number: record.get("number")?.as_u64()?,
                            title: record.get("title")?.as_str()?.to_string(),
                            body: record
                                .get("body")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                            url: record.get("url")?.as_str()?.to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(issues)
    }

    async fn create_github(&self, title: &str, body: &str) -> DeliveryResult {
        let output = match gh_command(
            &self.environment,
            &["issue", "create", "--title", title, "--body", body],
        ) {
            Ok(output) => output,
            Err(error) => {
                return DeliveryResult::Failed {
                    reason: error.to_string(),
                }
            }
        };
        if !output.status.success() {
            return DeliveryResult::Failed {
                reason: first_line(&String::from_utf8_lossy(&output.stderr)),
            };
        }
        let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if url.is_empty() {
            return DeliveryResult::Failed {
                reason: "gh issued no URL".to_string(),
            };
        }
        DeliveryResult::Created { url }
    }

    fn gitea_base(&self) -> Option<String> {
        self.environment
            .get("DEVBOARD_GITEA_URL")
            .filter(|value| !value.trim().is_empty())
            .map(|value| value.trim_end_matches('/').to_string())
            .or_else(|| self.origin.origin_url.clone())
    }

    async fn list_gitea(&self) -> anyhow::Result<Vec<OpenIssue>> {
        let base = self
            .gitea_base()
            .ok_or_else(|| anyhow::anyhow!("the Gitea address is not configured"))?;
        let token = self
            .environment
            .get("GITEA_TOKEN")
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("GITEA_TOKEN is not set"))?;
        let url = format!(
            "{base}/api/v1/repos/{}/issues?state=open&limit=100",
            self.origin.project
        );
        let response = reqwest::Client::new()
            .get(url)
            .header("Authorization", format!("token {token}"))
            .send()
            .await?;
        if !response.status().is_success() {
            anyhow::bail!("the open issues could not be read: {}", response.status());
        }
        let parsed: Value = response.json().await?;
        Ok(parsed
            .as_array()
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|entry| {
                        let record = entry.as_object()?;
                        Some(OpenIssue {
                            number: record.get("number")?.as_u64()?,
                            title: record.get("title")?.as_str()?.to_string(),
                            body: record
                                .get("body")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                            url: record.get("html_url")?.as_str()?.to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    async fn create_gitea(&self, title: &str, body: &str) -> DeliveryResult {
        let Some(base) = self.gitea_base() else {
            return DeliveryResult::Failed {
                reason: "the Gitea address is not configured".to_string(),
            };
        };
        let Some(token) = self.environment.get("GITEA_TOKEN") else {
            return DeliveryResult::Failed {
                reason: "GITEA_TOKEN is not set".to_string(),
            };
        };
        let url = format!("{base}/api/v1/repos/{}/issues", self.origin.project);
        let response = reqwest::Client::new()
            .post(url)
            .header("Authorization", format!("token {token}"))
            .json(&json!({ "title": title, "body": body }))
            .send()
            .await;
        match response {
            Ok(response) if response.status().is_success() => {
                match response.json::<Value>().await {
                    Ok(document) => match document
                        .as_object()
                        .and_then(|record| record.get("html_url"))
                        .and_then(Value::as_str)
                    {
                        Some(url) => DeliveryResult::Created {
                            url: url.to_string(),
                        },
                        None => DeliveryResult::Failed {
                            reason: "the Gitea response carried no issue URL".to_string(),
                        },
                    },
                    Err(error) => DeliveryResult::Failed {
                        reason: error.to_string(),
                    },
                }
            }
            Ok(response) => DeliveryResult::Failed {
                reason: format!("the issue could not be filed: {}", response.status()),
            },
            Err(error) => DeliveryResult::Failed {
                reason: error.to_string(),
            },
        }
    }
}

impl Delivery for NativeDelivery {
    fn repository(&self) -> String {
        self.repository.clone()
    }

    fn list(&self) -> DeliveryFuture<'_, anyhow::Result<Vec<OpenIssue>>> {
        Box::pin(async move {
            match self.origin.forge {
                ForgeKind::GitHub => self.list_github().await,
                ForgeKind::Gitea => self.list_gitea().await,
                ForgeKind::GitLab => {
                    anyhow::bail!(
                        "MCP optimizer supports a GitHub or Gitea origin, not a GitLab one"
                    )
                }
            }
        })
    }

    fn create<'a>(&'a self, title: String, body: String) -> DeliveryFuture<'a, DeliveryResult> {
        Box::pin(async move {
            let title = (self.redact)(&title);
            let body = (self.redact)(&body);
            match self.origin.forge {
                ForgeKind::GitHub => self.create_github(&title, &body).await,
                ForgeKind::Gitea => self.create_gitea(&title, &body).await,
                ForgeKind::GitLab => DeliveryResult::Failed {
                    reason: "MCP optimizer supports a GitHub or Gitea origin, not a GitLab one"
                        .to_string(),
                },
            }
        })
    }
}

/// The delivery for this checkout's origin, or the injected stub.
pub fn create_delivery(
    repo_dir: &Path,
    state_dir: &Path,
    environment: &HashMap<String, String>,
) -> anyhow::Result<Arc<dyn Delivery>> {
    // Peers receive these keys from the credential store, so a transcript can
    // echo a secret the worker process itself never held.
    let secrets = provider_secrets(state_dir);
    let pairs = environment_pairs(environment);
    let redact = Arc::new(move |text: &str| crate::redact::redact_secrets(text, &pairs, &secrets));
    let remote = origin_remote(repo_dir);
    let repository = remote
        .as_ref()
        .map(|remote| remote.project.clone())
        .unwrap_or_else(|| "fixture/fixture".to_string());
    if let Some(stub) = environment
        .get(MCP_OPTIMIZER_FORGE_STUB_ENV)
        .filter(|value| !value.is_empty())
    {
        return Ok(Arc::new(StubDelivery {
            directory: resolve(Path::new(stub)),
            repository,
            redact,
        }));
    }
    let Some(origin) = remote else {
        anyhow::bail!("the checkout's origin does not name a supported repository");
    };
    Ok(Arc::new(NativeDelivery {
        origin,
        repository,
        environment: environment.clone(),
        redact,
    }))
}

// ---------------------------------------------------------------------------
// One cycle

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FamilySummary {
    pub key: String,
    pub kind: FamilyKind,
    pub score: i64,
    pub calls: i64,
    pub sessions: usize,
    pub days: usize,
}

impl FamilySummary {
    fn of(family: &Family) -> Self {
        Self {
            key: family.key.clone(),
            kind: family.kind,
            score: family.score,
            calls: family.calls,
            sessions: family.sessions.len(),
            days: family.days,
        }
    }

    fn to_json(&self) -> Value {
        json!({
            "key": self.key,
            "kind": self.kind.as_str(),
            "score": self.score,
            "calls": self.calls,
            "sessions": self.sessions,
            "days": self.days,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SynthesisSummary {
    pub family: String,
    pub model: String,
    pub duration_ms: u64,
    pub ok: bool,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Validation {
    pub family: String,
    pub outcome: String,
    pub rule: Option<String>,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FiledIssue {
    pub family: String,
    pub title: String,
    pub kind: FamilyKind,
    pub url: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Duplicate {
    pub family: String,
    pub url: String,
    pub created_url: String,
    pub number: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReportWindow {
    pub start: String,
    pub end: String,
    pub minutes: u64,
}

#[derive(Clone, Debug)]
pub struct Report {
    pub cycle: String,
    pub window: ReportWindow,
    pub sessions: usize,
    pub session_files: usize,
    pub truncated: bool,
    pub skipped: usize,
    pub malformed: usize,
    pub journal_records: usize,
    pub families: usize,
    pub findings: Vec<FamilySummary>,
    pub selected: Vec<FamilySummary>,
    pub omitted: usize,
    pub ledger_reset: bool,
    pub synthesis: Vec<SynthesisSummary>,
    pub validations: Vec<Validation>,
    pub action: String,
    pub reason: Option<String>,
    pub issues: Vec<FiledIssue>,
    pub duplicates: Vec<Duplicate>,
    pub dropped: usize,
    pub pending: usize,
    pub report_path: String,
}

impl Report {
    pub fn to_json(&self) -> Value {
        let mut record = Map::new();
        record.insert("cycle".into(), Value::from(self.cycle.clone()));
        record.insert(
            "window".into(),
            json!({
                "start": self.window.start,
                "end": self.window.end,
                "minutes": self.window.minutes,
            }),
        );
        record.insert("sessions".into(), Value::from(self.sessions as u64));
        record.insert(
            "sessionFiles".into(),
            Value::from(self.session_files as u64),
        );
        record.insert("truncated".into(), Value::from(self.truncated));
        record.insert("skipped".into(), Value::from(self.skipped as u64));
        record.insert("malformed".into(), Value::from(self.malformed as u64));
        record.insert(
            "journalRecords".into(),
            Value::from(self.journal_records as u64),
        );
        record.insert("families".into(), Value::from(self.families as u64));
        record.insert(
            "findings".into(),
            Value::Array(self.findings.iter().map(FamilySummary::to_json).collect()),
        );
        record.insert(
            "selected".into(),
            Value::Array(self.selected.iter().map(FamilySummary::to_json).collect()),
        );
        record.insert("omitted".into(), Value::from(self.omitted as u64));
        record.insert("ledgerReset".into(), Value::from(self.ledger_reset));
        record.insert(
            "synthesis".into(),
            Value::Array(
                self.synthesis
                    .iter()
                    .map(|call| {
                        let mut entry = Map::new();
                        entry.insert("family".into(), Value::from(call.family.clone()));
                        entry.insert("model".into(), Value::from(call.model.clone()));
                        entry.insert("durationMs".into(), Value::from(call.duration_ms));
                        entry.insert("ok".into(), Value::from(call.ok));
                        if let Some(reason) = &call.reason {
                            entry.insert("reason".into(), Value::from(reason.clone()));
                        }
                        Value::Object(entry)
                    })
                    .collect(),
            ),
        );
        record.insert(
            "validations".into(),
            Value::Array(
                self.validations
                    .iter()
                    .map(|entry| {
                        let mut record = Map::new();
                        record.insert("family".into(), Value::from(entry.family.clone()));
                        record.insert("outcome".into(), Value::from(entry.outcome.clone()));
                        if let Some(rule) = &entry.rule {
                            record.insert("rule".into(), Value::from(rule.clone()));
                        }
                        if let Some(reason) = &entry.reason {
                            record.insert("reason".into(), Value::from(reason.clone()));
                        }
                        Value::Object(record)
                    })
                    .collect(),
            ),
        );
        record.insert("action".into(), Value::from(self.action.clone()));
        if let Some(reason) = &self.reason {
            record.insert("reason".into(), Value::from(reason.clone()));
        }
        record.insert(
            "issues".into(),
            Value::Array(
                self.issues
                    .iter()
                    .map(|issue| {
                        json!({
                            "family": issue.family,
                            "title": issue.title,
                            "kind": issue.kind.as_str(),
                            "url": issue.url,
                        })
                    })
                    .collect(),
            ),
        );
        record.insert(
            "duplicates".into(),
            Value::Array(
                self.duplicates
                    .iter()
                    .map(|entry| {
                        json!({
                            "family": entry.family,
                            "url": entry.url,
                            "createdUrl": entry.created_url,
                            "number": entry.number,
                        })
                    })
                    .collect(),
            ),
        );
        record.insert("dropped".into(), Value::from(self.dropped as u64));
        record.insert("pending".into(), Value::from(self.pending as u64));
        record.insert("reportPath".into(), Value::from(self.report_path.clone()));
        Value::Object(record)
    }
}

pub struct CycleResult {
    pub report: Report,
    pub exit_code: i32,
    pub run_dir: Option<PathBuf>,
}

/// Renders the CLI's human line from a finished cycle.
pub fn describe_cycle(result: &CycleResult) -> String {
    let report = &result.report;
    format!(
        "mcp-optimizer: {} — {} ({} family/families, {} selected, {} filed, {} pending)",
        report.action,
        report
            .reason
            .clone()
            .unwrap_or_else(|| "no reason".to_string()),
        report.families,
        report.selected.len(),
        report.issues.len(),
        report.pending
    )
}

fn render_markdown(report: &Report) -> String {
    let list = |entries: Vec<String>, empty: &str| -> Vec<String> {
        if entries.is_empty() {
            vec![empty.to_string()]
        } else {
            entries
        }
    };
    let selected = list(
        report
            .selected
            .iter()
            .map(|family| {
                format!(
                    "- `{}` ({}) score {} — {} call(s), {} session(s), {} day(s)",
                    family.key,
                    family.kind.as_str(),
                    family.score,
                    family.calls,
                    family.sessions,
                    family.days
                )
            })
            .collect(),
        "None.",
    );
    let synthesis = list(
        report
            .synthesis
            .iter()
            .map(|call| {
                format!(
                    "- `{}`: {}, {}ms, {}",
                    call.family,
                    call.model,
                    call.duration_ms,
                    if call.ok {
                        "ok".to_string()
                    } else {
                        format!(
                            "failed — {}",
                            call.reason
                                .clone()
                                .unwrap_or_else(|| "no reason".to_string())
                        )
                    }
                )
            })
            .collect(),
        "None.",
    );
    let validations = list(
        report
            .validations
            .iter()
            .map(|entry| {
                let mut line = format!("- `{}`: {}", entry.family, entry.outcome);
                if let Some(rule) = &entry.rule {
                    line.push_str(&format!(" ({rule})"));
                }
                if let Some(reason) = &entry.reason {
                    line.push_str(&format!(" — {reason}"));
                }
                line
            })
            .collect(),
        "None.",
    );
    let issues = list(
        report
            .issues
            .iter()
            .map(|issue| format!("- {} — {}", issue.url, issue.title))
            .collect(),
        "None.",
    );
    let duplicates = list(
        report
            .duplicates
            .iter()
            .map(|entry| {
                format!(
                    "- `{}`: created {}, duplicates {}",
                    entry.family, entry.created_url, entry.url
                )
            })
            .collect(),
        "None.",
    );
    let mut lines: Vec<String> = vec![
        format!("# MCP optimizer cycle {}", report.cycle),
        String::new(),
        format!("- Window: {} .. {}", report.window.start, report.window.end),
        format!("- Action: {}", report.action),
        format!(
            "- Reason: {}",
            report.reason.clone().unwrap_or_else(|| "none".to_string())
        ),
        format!(
            "- Sessions: {} of {} selected{}",
            report.sessions,
            report.session_files,
            if report.truncated { " (truncated)" } else { "" }
        ),
        format!(
            "- Skips: {}, malformed lines: {}",
            report.skipped, report.malformed
        ),
        format!("- Journal records: {}", report.journal_records),
        format!(
            "- Families: {}, selected: {}, omitted: {}",
            report.families,
            report.selected.len(),
            report.omitted
        ),
        format!(
            "- Ledger reset: {}",
            if report.ledger_reset { "yes" } else { "no" }
        ),
        format!("- Pending: {}, dropped: {}", report.pending, report.dropped),
        String::new(),
        "## Selected families".to_string(),
        String::new(),
    ];
    lines.extend(selected);
    lines.extend([String::new(), "## Synthesis".to_string(), String::new()]);
    lines.extend(synthesis);
    lines.extend([String::new(), "## Validation".to_string(), String::new()]);
    lines.extend(validations);
    lines.extend([String::new(), "## Issues".to_string(), String::new()]);
    lines.extend(issues);
    lines.extend([String::new(), "## Duplicates".to_string(), String::new()]);
    lines.extend(duplicates);
    lines.push(String::new());
    lines.join("\n")
}

fn duplicate_of(open_issues: &[OpenIssue], title: &str, family: &str) -> Option<OpenIssue> {
    let tag = format!("family:{}", family_tag(family));
    open_issues
        .iter()
        .find(|issue| issue.title == title || issue.body.contains(&tag))
        .cloned()
}

fn filings_this_hour(ledger: &Ledger, now: OffsetDateTime) -> u64 {
    let start = epoch_millis(now) - 3_600_000;
    ledger
        .families
        .iter()
        .filter(|(_, entry)| {
            entry
                .last_filed_at
                .as_deref()
                .and_then(parse_instant_millis)
                .map(|filed_at| filed_at > start)
                .unwrap_or(false)
        })
        .count() as u64
}

/// The remaining hourly filing room; `None` is unlimited.
fn hourly_room(settings: &Settings, ledger: &Ledger, now: OffsetDateTime) -> Option<u64> {
    let limit = settings.max_per_hour?;
    Some(u64::from(limit).saturating_sub(filings_this_hour(ledger, now)))
}

pub struct CycleOptions {
    /// The repository root the cycle reads.
    pub root: PathBuf,
    /// The dashboard's STATE_DIR; MCP optimizer files live under its `coach/`.
    pub state_dir: PathBuf,
    pub now: Option<OffsetDateTime>,
    pub dry_run: bool,
    pub settings: Option<Settings>,
    pub environment: HashMap<String, String>,
    /// Test seams.
    pub collect: Option<Arc<dyn Fn() -> Collection + Send + Sync>>,
    pub delivery: Option<Arc<dyn Delivery>>,
    pub open_issues: Option<Vec<OpenIssue>>,
    pub synthesize: Option<Synthesize>,
}

impl CycleOptions {
    pub fn new(root: impl Into<PathBuf>, state_dir: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            state_dir: state_dir.into(),
            now: None,
            dry_run: false,
            settings: None,
            environment: std::env::vars().collect(),
            collect: None,
            delivery: None,
            open_issues: None,
            synthesize: None,
        }
    }
}

fn finish_cycle(
    report: &mut Report,
    ledger: &Ledger,
    directory: &Path,
    run_dir: &Path,
    report_path: &Path,
    family_count: usize,
    capped_reason: Option<String>,
    failure: Option<String>,
) -> anyhow::Result<CycleResult> {
    report.pending = 0;
    if let Some(failure) = failure {
        report.action = "failed".to_string();
        report.reason = Some(failure);
    } else if !report.issues.is_empty() {
        report.action = "filed".to_string();
        report.reason = Some(format!("filed {} issue(s)", report.issues.len()));
    } else if family_count == 0 {
        report.action = "none".to_string();
        report.reason = Some("no family in the window".to_string());
    } else if let Some(capped) = capped_reason {
        report.action = "capped".to_string();
        report.reason = Some(capped);
    } else {
        report.action = "none".to_string();
        report.reason = Some("no family filed a proposal".to_string());
    }
    save_ledger(directory, ledger)?;
    std::fs::create_dir_all(run_dir)?;
    let value = report.to_json();
    std::fs::write(report_path, json_file_text(&value))?;
    std::fs::write(latest_path(directory), json_file_text(&value))?;
    std::fs::write(run_dir.join("report.md"), render_markdown(report))?;
    Ok(CycleResult {
        report: report.clone(),
        exit_code: if report.action == "failed" { 1 } else { 0 },
        run_dir: Some(run_dir.to_path_buf()),
    })
}

/// Runs one MCP optimizer cycle. The caller owns the singleton lock.
pub async fn run_cycle(options: CycleOptions) -> anyhow::Result<CycleResult> {
    let root = resolve(&options.root);
    let state_dir = resolve(&options.state_dir);
    let directory = mcp_optimizer_directory(&state_dir);
    let now = options.now.unwrap_or_else(OffsetDateTime::now_utc);
    let window_start = from_millis(epoch_millis(now) - EVIDENCE_WINDOW_MS);
    let settings = options
        .settings
        .clone()
        .unwrap_or_else(|| read_settings(&directory));
    let collection = match &options.collect {
        Some(collect) => collect(),
        None => collect_evidence(&state_dir, &root, window_start, now),
    };
    let selection = build_families(
        &collection.sessions,
        &collection.journal,
        epoch_millis(window_start),
        epoch_millis(now),
        &root,
    );
    let loaded = load_ledger(&directory);
    let mut ledger = loaded.ledger;
    if !options.dry_run {
        record_families(&mut ledger, &selection.families, now);
    }
    let run_dir = runs_directory(&directory).join(stamp(now));
    let report_path = run_dir.join("report.json");
    let selected: Vec<FamilySummary> = selection.selected.iter().map(FamilySummary::of).collect();
    let mut report = Report {
        cycle: iso(now),
        window: ReportWindow {
            start: collection.window_start.clone(),
            end: collection.window_end.clone(),
            minutes: (EVIDENCE_WINDOW_MS / 60_000) as u64,
        },
        sessions: collection.sessions.len(),
        session_files: collection.session_files,
        truncated: collection.truncated,
        skipped: collection.skipped,
        malformed: collection.malformed,
        journal_records: collection.journal_records,
        families: selection.families.len(),
        findings: selected.clone(),
        selected,
        omitted: selection.omitted,
        ledger_reset: loaded.reset,
        synthesis: Vec::new(),
        validations: Vec::new(),
        action: "none".to_string(),
        reason: None,
        issues: Vec::new(),
        duplicates: Vec::new(),
        dropped: 0,
        pending: 0,
        report_path: report_path.to_string_lossy().into_owned(),
    };

    if options.dry_run {
        report.reason = Some(if selection.families.is_empty() {
            "no family in the window".to_string()
        } else {
            format!(
                "dry run: {} family/families, {} selected for synthesis",
                selection.families.len(),
                selection.selected.len()
            )
        });
        return Ok(CycleResult {
            report,
            exit_code: 0,
            run_dir: None,
        });
    }

    let mut delivery = options.delivery.clone();
    let mut delivery_failure: Option<String> = None;
    let mut open_issues: Vec<OpenIssue> = Vec::new();
    let mut failure: Option<String> = None;

    // A queue written by an older revision is discarded, not filed: the
    // synthesis turn files its own proposal or records why it filed none.
    if !ledger.pending_filing.is_empty() {
        let dropped = std::mem::take(&mut ledger.pending_filing);
        report.dropped += dropped.len();
        for pending in dropped {
            report.validations.push(Validation {
                family: pending.family,
                outcome: "dropped".to_string(),
                rule: Some("pending-queue-removed".to_string()),
                reason: Some(
                    "the proposal queue is gone; the synthesis turn files directly".to_string(),
                ),
            });
        }
    }

    if !selection.selected.is_empty() {
        if delivery.is_none() && delivery_failure.is_none() {
            match create_delivery(&root, &state_dir, &options.environment) {
                Ok(created) => delivery = Some(created),
                Err(error) => delivery_failure = Some(error_line(&error)),
            }
        }
        match (&delivery, &options.open_issues) {
            (None, _) => {
                failure =
                    Some(delivery_failure.clone().unwrap_or_else(|| {
                        "the MCP optimizer delivery is unavailable".to_string()
                    }));
            }
            (Some(_), Some(issues)) => open_issues = issues.clone(),
            (Some(active), None) => match active.list().await {
                Ok(issues) => open_issues = issues,
                Err(error) => {
                    failure = Some(format!(
                        "the open issues could not be read: {}",
                        error_line(&error)
                    ))
                }
            },
        }
    }
    if let Some(failure) = failure {
        return finish_cycle(
            &mut report,
            &ledger,
            &directory,
            &run_dir,
            &report_path,
            selection.families.len(),
            None,
            Some(failure),
        );
    }

    let mut cycle_filed: i64 = 0;
    let mut room = hourly_room(&settings, &ledger, now);
    let mut capped_reason: Option<String> = None;
    let mut capped_families: HashSet<String> = HashSet::new();

    let to_synthesize = selection.selected.clone();

    if !to_synthesize.is_empty() {
        let stub_path = options
            .environment
            .get(SYNTHESIS_STUB_ENV)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from);
        let default_run: Synthesize = {
            let stub_path = stub_path.clone();
            let root = root.clone();
            let state_dir = state_dir.clone();
            let environment = options.environment.clone();
            Arc::new(
                move |family: Family, prompt: String, paths: SynthesisPaths| {
                    let stub_path = stub_path.clone();
                    let root = root.clone();
                    let state_dir = state_dir.clone();
                    let environment = environment.clone();
                    Box::pin(async move {
                        if let Some(stub_path) = stub_path {
                            let runner = match read_synthesis_stub(&stub_path, &family.key, &paths)
                            {
                                Ok(runner) => runner,
                                Err(error) => {
                                    return SynthesisResult {
                                        ok: false,
                                        model: String::new(),
                                        duration_ms: 0,
                                        text: None,
                                        reason: Some(error_line(&error)),
                                    }
                                }
                            };
                            return match runner(prompt).await {
                                Ok(text) => SynthesisResult {
                                    ok: true,
                                    model: "stub".to_string(),
                                    duration_ms: 0,
                                    text: Some(text),
                                    reason: None,
                                },
                                Err(error) => SynthesisResult {
                                    ok: false,
                                    model: "stub".to_string(),
                                    duration_ms: 0,
                                    text: None,
                                    reason: Some(error_line(&error)),
                                },
                            };
                        }
                        synthesize_family(SynthesizeOptions {
                            repo_dir: root,
                            state_dir,
                            family,
                            prompt,
                            environment,
                            command: None,
                            timeout_ms: None,
                            tool_log_path: Some(paths.tool_log_path),
                            skip_log_path: Some(paths.skip_log_path),
                            run: None,
                        })
                        .await
                    })
                },
            )
        };
        let run: Synthesize = options.synthesize.clone().unwrap_or(default_run);
        let open_optimizer_issues = mcp_optimizer_issues(&open_issues);
        let available: i64 = std::cmp::max(
            0,
            std::cmp::min(
                i64::from(settings.max_issues_per_cycle) - cycle_filed,
                room.map(|room| room as i64)
                    .unwrap_or(to_synthesize.len() as i64),
            ),
        );
        if available == 0 {
            capped_reason = Some(match room {
                Some(0) => format!(
                    "maxPerHour {} reached; {} family/families suppressed",
                    settings.max_per_hour.unwrap_or(0),
                    to_synthesize.len()
                ),
                _ => format!(
                    "maxIssuesPerCycle {} reached; {} family/families suppressed",
                    settings.max_issues_per_cycle,
                    to_synthesize.len()
                ),
            });
        }
        struct Work {
            family: Family,
            paths: SynthesisPaths,
            prompt: String,
        }
        let mut work: Vec<Work> = Vec::new();
        for (index, family) in to_synthesize.iter().enumerate() {
            let sanitized = family
                .key
                .chars()
                .map(|character| {
                    if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                        character
                    } else {
                        '-'
                    }
                })
                .collect::<String>();
            let directory = run_dir.join("families").join(sanitized);
            std::fs::create_dir_all(&directory)?;
            let paths = SynthesisPaths {
                tool_log_path: directory.join("tool-log.jsonl"),
                skip_log_path: directory.join("skips.jsonl"),
            };
            let filing_room = if (index as i64) < available { 1 } else { 0 };
            if filing_room == 0 {
                capped_families.insert(family.key.clone());
            }
            work.push(Work {
                family: family.clone(),
                paths,
                prompt: synthesis_prompt(family, &settings, &open_optimizer_issues, filing_room),
            });
        }
        let calls: Vec<(Family, SynthesisPaths, SynthesisResult)> = {
            use futures_util::StreamExt;
            futures_util::stream::iter(work.into_iter().map(|item| {
                let run = run.clone();
                async move {
                    let result = run(item.family.clone(), item.prompt, item.paths.clone()).await;
                    (item.family, item.paths, result)
                }
            }))
            .buffered(SYNTHESIS_CONCURRENCY)
            .collect::<Vec<_>>()
            .await
        };
        for (family, _, result) in &calls {
            report.synthesis.push(SynthesisSummary {
                family: family.key.clone(),
                model: result.model.clone(),
                duration_ms: result.duration_ms,
                ok: result.ok,
                reason: result.reason.clone(),
            });
        }
        let failed: Vec<&(Family, SynthesisPaths, SynthesisResult)> =
            calls.iter().filter(|(_, _, result)| !result.ok).collect();
        if !failed.is_empty() {
            for (family, _, _) in &failed {
                mark_family(
                    &mut ledger,
                    &family.key,
                    FamilyAction::Failed,
                    &MarkOptions {
                        at: now,
                        issue_url: None,
                        title: None,
                    },
                );
            }
            if failed.len() == calls.len() {
                let keys: Vec<String> = failed
                    .iter()
                    .map(|(family, _, _)| family.key.clone())
                    .collect();
                let reason = failed
                    .first()
                    .and_then(|(_, _, result)| result.reason.clone())
                    .unwrap_or_else(|| "no diagnostic".to_string());
                return finish_cycle(
                    &mut report,
                    &ledger,
                    &directory,
                    &run_dir,
                    &report_path,
                    selection.families.len(),
                    None,
                    Some(format!(
                        "synthesis failed for {}: {reason}",
                        keys.join(", ")
                    )),
                );
            }
        }

        for (family, paths, result) in &calls {
            if !result.ok {
                continue;
            }
            let filings: Vec<Value> = read_tool_log(&paths.tool_log_path)
                .into_iter()
                .filter(|entry| {
                    entry.get("tool").and_then(Value::as_str) == Some("issue_create")
                        && entry.get("ok").and_then(Value::as_bool) == Some(true)
                })
                .collect();
            let filed = filings.last();
            let number = filed.and_then(|entry| {
                entry
                    .get("value")
                    .and_then(|value| tool_value_number(value, "number"))
            });
            let title = filed.and_then(|entry| {
                entry
                    .get("value")
                    .and_then(|value| tool_value_string(value, "title"))
            });
            let url = filed.and_then(|entry| {
                entry
                    .get("value")
                    .and_then(|value| tool_value_string(value, "url"))
            });
            if let (Some(number), Some(title), Some(url)) = (number, title, url) {
                if let Some(duplicate) = duplicate_of(&open_issues, &title, &family.key) {
                    report.duplicates.push(Duplicate {
                        family: family.key.clone(),
                        url: duplicate.url.clone(),
                        created_url: url.clone(),
                        number,
                    });
                    report.validations.push(Validation {
                        family: family.key.clone(),
                        outcome: "duplicate".to_string(),
                        rule: Some("open-issue".to_string()),
                        reason: Some(format!("{url} duplicates {}", duplicate.url)),
                    });
                    mark_family(
                        &mut ledger,
                        &family.key,
                        FamilyAction::Duplicate,
                        &MarkOptions {
                            at: now,
                            issue_url: None,
                            title: None,
                        },
                    );
                    continue;
                }
                cycle_filed += 1;
                if let Some(room) = &mut room {
                    *room = room.saturating_sub(1);
                }
                report.issues.push(FiledIssue {
                    family: family.key.clone(),
                    title: title.clone(),
                    kind: family.kind,
                    url: url.clone(),
                });
                report.validations.push(Validation {
                    family: family.key.clone(),
                    outcome: "filed".to_string(),
                    rule: None,
                    reason: None,
                });
                mark_family(
                    &mut ledger,
                    &family.key,
                    FamilyAction::Filed,
                    &MarkOptions {
                        at: now,
                        issue_url: Some(url.clone()),
                        title: Some(title.clone()),
                    },
                );
                open_issues.push(OpenIssue {
                    number: open_issues.len() as u64 + 1,
                    title,
                    body: String::new(),
                    url,
                });
                continue;
            }
            let skips: Vec<Value> = read_tool_log(&paths.skip_log_path)
                .into_iter()
                .filter(|entry| {
                    entry.get("tool").and_then(Value::as_str) == Some("mcp_optimizer_proposal_skip")
                        && entry.get("ok").and_then(Value::as_bool) == Some(true)
                })
                .collect();
            let reason = skips.last().and_then(|entry| {
                entry
                    .get("value")
                    .and_then(|value| tool_value_string(value, "reason"))
            });
            report.validations.push(Validation {
                family: family.key.clone(),
                outcome: "skipped".to_string(),
                rule: Some(if reason.is_some() {
                    "tool".to_string()
                } else {
                    "no-filing".to_string()
                }),
                reason: Some(
                    reason.unwrap_or_else(|| "the synthesis turn filed nothing".to_string()),
                ),
            });
            mark_family(
                &mut ledger,
                &family.key,
                if capped_families.contains(&family.key) {
                    FamilyAction::Capped
                } else {
                    FamilyAction::None
                },
                &MarkOptions {
                    at: now,
                    issue_url: None,
                    title: None,
                },
            );
        }
    }

    finish_cycle(
        &mut report,
        &ledger,
        &directory,
        &run_dir,
        &report_path,
        selection.families.len(),
        capped_reason,
        None,
    )
}

// ---------------------------------------------------------------------------
// Locks

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LockOwner {
    pub pid: u32,
    /// ISO 8601 start time of the owning process, from its own clock.
    pub started_at: String,
    pub repo: String,
    pub state_dir: String,
    pub harness_version: Option<String>,
    pub argv: Vec<String>,
    /// Per-acquisition identity; absent on locks written by older harnesses.
    pub token: Option<String>,
}

pub fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
        if result == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(not(unix))]
    {
        false
    }
}

/// The instant a live process started, in epoch milliseconds, derived from
/// `/proc/<pid>/stat` and the kernel's own uptime.
fn process_started_at(pid: u32) -> Option<i64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let close = stat.rfind(')')?;
    let suffix = &stat[close + 1..];
    let start_ticks: f64 = suffix.split_whitespace().nth(19)?.parse().ok()?;
    let uptime: f64 = std::fs::read_to_string("/proc/uptime")
        .ok()?
        .split_whitespace()
        .next()?
        .parse()
        .ok()?;
    Some((now_millis() as f64 - uptime * 1000.0 + start_ticks * 10.0) as i64)
}

/// The instant this process started, for the lock it writes.
fn own_started_at() -> String {
    process_started_at(std::process::id())
        .map(from_millis)
        .map(iso)
        .unwrap_or_else(now_iso)
}

const START_TIME_TOLERANCE_MS: i64 = 2_000;

/// True when the live process with `owner.pid` is the lock's own owner, not a
/// recycled pid.
fn owner_alive(owner: &LockOwner) -> bool {
    if !pid_alive(owner.pid) {
        return false;
    }
    let Some(recorded) = parse_instant_millis(&owner.started_at) else {
        return false;
    };
    match process_started_at(owner.pid) {
        Some(actual) => (actual - recorded).abs() <= START_TIME_TOLERANCE_MS,
        None => cfg!(not(target_os = "linux")),
    }
}

fn parse_lock(content: &str) -> (Option<LockOwner>, Option<String>) {
    let Ok(parsed) = serde_json::from_str::<Value>(content) else {
        return (None, None);
    };
    let Some(record) = parsed.as_object() else {
        return (None, None);
    };
    let Some(pid) = record.get("pid").and_then(number_field) else {
        return (None, None);
    };
    let Some(started_at) = record.get("startedAt").and_then(Value::as_str) else {
        return (None, None);
    };
    if pid.fract() != 0.0 || pid <= 0.0 {
        return (None, None);
    }
    let argv: Vec<String> = record
        .get("argv")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    (
        Some(LockOwner {
            pid: pid as u32,
            started_at: started_at.to_string(),
            repo: record
                .get("repo")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            state_dir: record
                .get("stateDir")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            harness_version: record
                .get("harnessVersion")
                .and_then(Value::as_str)
                .map(str::to_string),
            argv,
            token: record
                .get("token")
                .and_then(Value::as_str)
                .map(str::to_string),
        }),
        record
            .get("token")
            .and_then(Value::as_str)
            .map(str::to_string),
    )
}

/// The lock's owner, if the file is present and readable.
pub fn read_lock(path: &Path) -> Option<LockOwner> {
    let content = std::fs::read_to_string(path).ok()?;
    parse_lock(&content).0
}

/// The live owner of a lock, or `None` when it is missing or stale.
pub fn live_lock_owner(path: &Path) -> Option<LockOwner> {
    let owner = read_lock(path)?;
    owner_alive(&owner).then_some(owner)
}

/// Every live owner beside one lock path: the legacy lock and each version.
pub fn live_lock_owners(path: &Path) -> Vec<LockOwner> {
    let mut owners = Vec::new();
    if let Some(owner) = live_lock_owner(path) {
        owners.push(owner);
    }
    let Some(directory) = path.parent() else {
        return owners;
    };
    let Ok(entries) = std::fs::read_dir(directory) else {
        return owners;
    };
    let Some(base) = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
    else {
        return owners;
    };
    let prefix = format!("{base}.");
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.starts_with(&prefix))
        .filter(|name| !name.contains(".reclaim-") && !name.contains(".new-"))
        .collect();
    names.sort();
    for name in names {
        if let Some(owner) = live_lock_owner(&directory.join(name)) {
            owners.push(owner);
        }
    }
    owners
}

struct LockSnapshot {
    owner: Option<LockOwner>,
    token: Option<String>,
    device: u64,
    inode: u64,
}

fn read_snapshot(path: &Path) -> Option<LockSnapshot> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = std::fs::metadata(path).ok()?;
        let content = std::fs::read_to_string(path).ok()?;
        let (owner, token) = parse_lock(&content);
        return Some(LockSnapshot {
            owner,
            token,
            device: metadata.dev(),
            inode: metadata.ino(),
        });
    }
    #[allow(unreachable_code)]
    {
        let content = std::fs::read_to_string(path).ok()?;
        let (owner, token) = parse_lock(&content);
        Some(LockSnapshot {
            owner,
            token,
            device: 0,
            inode: 0,
        })
    }
}

fn same_lock_file(left: &LockSnapshot, right: &LockSnapshot) -> bool {
    if left.token.is_some() || right.token.is_some() {
        return left.token.is_some() && left.token == right.token;
    }
    left.device == right.device && left.inode == right.inode
}

/// Reclaims `inspected` without ever deleting whatever currently sits at
/// `path` by guess.
fn reclaim_stale_lock(path: &Path, inspected: &LockSnapshot) {
    let aside = PathBuf::from(format!(
        "{}.reclaim-{}-{}",
        path.display(),
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    if std::fs::rename(path, &aside).is_err() {
        return;
    }
    let moved = read_snapshot(&aside);
    match moved {
        Some(moved) if same_lock_file(inspected, &moved) => {
            let _ = std::fs::remove_file(&aside);
        }
        _ => {
            if std::fs::hard_link(&aside, path).is_ok() {
                let _ = std::fs::remove_file(&aside);
            }
        }
    }
}

/// A held lock; dropping it removes the lock file only when it is still this
/// acquisition's.
pub struct LockGuard {
    path: PathBuf,
    token: String,
}

impl LockGuard {
    pub fn release(self) {}
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        if let Some(current) = read_snapshot(&self.path) {
            if current.token.as_deref() != Some(self.token.as_str()) {
                return;
            }
        }
        let _ = std::fs::remove_file(&self.path);
    }
}

pub struct LockDetails {
    pub repo: String,
    pub state_dir: String,
    pub harness_version: Option<String>,
    pub argv: Vec<String>,
}

/// Takes the lock, or reports the live owner. A lock whose owner is gone or
/// whose pid was recycled is reclaimed once; a second failure means a
/// concurrent start won the race.
// The refusal carries the live owner record itself; boxing it would allocate on
// a path that exists to report an already-running worker, not to be cheap.
#[allow(clippy::result_large_err)]
pub fn acquire_lock(path: &Path, details: &LockDetails) -> Result<LockGuard, Option<LockOwner>> {
    if let Some(directory) = path.parent() {
        let _ = std::fs::create_dir_all(directory);
    }
    let owner = LockOwner {
        pid: std::process::id(),
        started_at: own_started_at(),
        repo: details.repo.clone(),
        state_dir: details.state_dir.clone(),
        harness_version: details.harness_version.clone(),
        argv: details.argv.clone(),
        token: None,
    };
    let token = uuid::Uuid::new_v4().to_string();
    for _attempt in 0..2 {
        let staged = PathBuf::from(format!(
            "{}.new-{}-{}",
            path.display(),
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let mut record = Map::new();
        record.insert("pid".into(), Value::from(owner.pid));
        record.insert("startedAt".into(), Value::from(owner.started_at.clone()));
        record.insert("repo".into(), Value::from(owner.repo.clone()));
        record.insert("stateDir".into(), Value::from(owner.state_dir.clone()));
        record.insert(
            "harnessVersion".into(),
            owner
                .harness_version
                .clone()
                .map(Value::from)
                .unwrap_or(Value::Null),
        );
        record.insert(
            "argv".into(),
            Value::Array(owner.argv.iter().cloned().map(Value::from).collect()),
        );
        record.insert("token".into(), Value::from(token.clone()));
        let mut text = crate::jsjson::stringify(&Value::Object(record));
        text.push('\n');
        let staged_result = std::fs::write(&staged, text);
        if staged_result.is_err() {
            let _ = std::fs::remove_file(&staged);
            return Err(None);
        }
        let linked = std::fs::hard_link(&staged, path);
        let _ = std::fs::remove_file(&staged);
        match linked {
            Ok(()) => {
                return Ok(LockGuard {
                    path: path.to_path_buf(),
                    token,
                })
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let Some(snapshot) = read_snapshot(path) else {
                    continue;
                };
                if let Some(current) = &snapshot.owner {
                    if owner_alive(current) {
                        return Err(Some(current.clone()));
                    }
                }
                reclaim_stale_lock(path, &snapshot);
            }
            Err(_) => return Err(None),
        }
    }
    Err(None)
}

// ---------------------------------------------------------------------------
// The detached worker

/// Published when another version's worker holds the one cycle lease.
pub const CYCLE_BUSY_NOTICE: &str =
    "Another MCP optimizer worker is running a cycle; this worker retries shortly.";

const CONTROL_POLL_MS: u64 = 250;

/// The cycle seam: production runs [`run_cycle`], tests replace it.
pub trait CycleRunner: Send + Sync {
    fn run<'a>(
        &'a self,
        options: CycleOptions,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<CycleResult>> + Send + 'a>>;
}

pub struct RealCycle;

impl CycleRunner for RealCycle {
    fn run<'a>(
        &'a self,
        options: CycleOptions,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<CycleResult>> + Send + 'a>> {
        Box::pin(run_cycle(options))
    }
}

pub struct WorkerOptions {
    /// The checkout the cycle reads.
    pub root: PathBuf,
    /// The dashboard's STATE_DIR; MCP optimizer files live under its `coach/`.
    pub state_dir: PathBuf,
    /// The STATE_DIR that decides ownership; defaults to `state_dir`.
    pub owner_state_dir: Option<PathBuf>,
    /// The harness version this worker runs; defaults to the source tree's.
    pub harness_version: Option<Option<String>>,
    /// Test seam: the cycle function, defaulting to the real cycle.
    pub cycle: Option<Arc<dyn CycleRunner>>,
    /// Test seam: how often control files are consumed.
    pub control_poll_ms: Option<u64>,
    /// Test seam: replaces stderr reporting.
    pub log: Option<Arc<dyn Fn(&str) + Send + Sync>>,
    /// The argv the worker publishes, defaulting to this process's.
    pub argv: Vec<String>,
}

impl WorkerOptions {
    pub fn new(root: impl Into<PathBuf>, state_dir: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            state_dir: state_dir.into(),
            owner_state_dir: None,
            harness_version: None,
            cycle: None,
            control_poll_ms: None,
            log: None,
            argv: std::env::args().collect(),
        }
    }
}

struct WorkerRuntime {
    root: PathBuf,
    owner_state_dir: PathBuf,
    directory: PathBuf,
    version_directory: PathBuf,
    version_control_directory: PathBuf,
    harness_version: Option<String>,
    argv: Vec<String>,
    started_at: String,
    settings: Settings,
    stopping: bool,
    draining: bool,
    last_run_at: Option<String>,
    next_run_at: Option<String>,
    last_error: Option<String>,
    notice: Option<String>,
}

impl WorkerRuntime {
    fn cadence_ms(&self) -> u64 {
        std::cmp::max(60_000, u64::from(self.settings.interval_minutes) * 60_000)
    }

    fn recompute_next(&mut self) {
        let Some(last) = self.last_run_at.clone() else {
            self.next_run_at = Some(now_iso());
            return;
        };
        self.next_run_at = match parse_instant_millis(&last) {
            Some(started) => Some(iso(from_millis(started + self.cadence_ms() as i64))),
            None => Some(now_iso()),
        };
    }

    fn publish(&self, lifecycle: Lifecycle, enabled: bool) {
        let state = WorkerState {
            pid: std::process::id(),
            started_at: self.started_at.clone(),
            root: self.root.to_string_lossy().into_owned(),
            state_dir: self.owner_state_dir.to_string_lossy().into_owned(),
            lifecycle,
            enabled,
            draining: self.draining,
            harness_version: self.harness_version.clone(),
            argv: self.argv.clone(),
            last_run_at: self.last_run_at.clone(),
            next_run_at: self.next_run_at.clone(),
            last_error: self.last_error.clone(),
            notice: self.notice.clone(),
            updated_at: now_iso(),
        };
        let _ = write_worker_state(&self.version_directory, &state);
    }

    fn request_stop(&mut self) {
        if self.stopping {
            return;
        }
        self.stopping = true;
        self.publish(Lifecycle::Stopping, false);
    }

    fn apply(&mut self, command: Command) {
        match command {
            Command::Stop => self.request_stop(),
            Command::Drain => {
                // A newer version owns new work. The in-flight cycle, if any,
                // keeps running; the loop starts nothing new and exits once it
                // is done.
                self.draining = true;
                self.notice = Some(
                    "Draining: this worker finishes its in-flight cycle, then exits.".to_string(),
                );
                self.publish(Lifecycle::Stopping, false);
            }
            Command::Settings {
                interval_minutes,
                max_per_hour,
                max_pending,
            } => {
                // Read-modify-write against the file. Only the three cadence
                // keys come from the command, so a dashboard save the worker
                // has not read back keeps its allowlist and cycle cap.
                let mut settings = read_settings(&self.directory);
                settings.interval_minutes = interval_minutes;
                settings.max_per_hour = max_per_hour;
                settings.max_pending = max_pending;
                self.settings = settings.clone();
                let _ = write_settings(&self.directory, &settings);
                self.recompute_next();
                self.notice = Some(format!(
                    "Settings saved: every {interval_minutes} minute(s)."
                ));
                self.publish(Lifecycle::Running, true);
            }
        }
    }

    fn consume(&mut self) {
        // Settings and the legacy control directory are shared, so an operator
        // command written by an older dashboard is honoured alongside this
        // version's own control files.
        let legacy = control_directory(&self.directory);
        if legacy.is_dir() {
            for command in take_commands(&legacy) {
                self.apply(command);
            }
        }
        for command in take_commands(&self.version_control_directory) {
            self.apply(command);
        }
    }
}

fn worker_harness_version() -> Option<String> {
    if let Ok(version) = std::env::var("DEVBOARD_HARNESS_VERSION") {
        if !version.is_empty() {
            return Some(version);
        }
    }
    crate::version::read_harness_version(&crate::version::running_harness_dir())
}

/// Runs one detached worker until Stop, Drain, or a signal ends it. Returns the
/// process exit code; the caller owns the process.
pub async fn run_worker(options: WorkerOptions) -> anyhow::Result<i32> {
    let root = resolve(&options.root);
    let state_dir = resolve(&options.state_dir);
    let owner_state_dir = resolve(
        &options
            .owner_state_dir
            .clone()
            .unwrap_or_else(|| state_dir.clone()),
    );
    let directory = mcp_optimizer_directory(&state_dir);
    let harness_version = match &options.harness_version {
        Some(version) => version.clone(),
        None => worker_harness_version(),
    };
    let log: Arc<dyn Fn(&str) + Send + Sync> = options
        .log
        .clone()
        .unwrap_or_else(|| Arc::new(|line: &str| eprintln!("{line}")));
    let cycle: Arc<dyn CycleRunner> = options.cycle.clone().unwrap_or_else(|| Arc::new(RealCycle));
    let control_poll_ms = std::cmp::max(10, options.control_poll_ms.unwrap_or(CONTROL_POLL_MS));
    let version_directory = versioned_worker_directory(&directory, harness_version.as_deref());
    let version_control_directory =
        versioned_control_directory(&directory, harness_version.as_deref());

    // A worker of another version never holds this path, so a takeover can
    // start beside it; only the same version's live worker refuses this start.
    let lock = match acquire_lock(
        &versioned_lock_path(&directory, harness_version.as_deref()),
        &LockDetails {
            repo: root.to_string_lossy().into_owned(),
            state_dir: owner_state_dir.to_string_lossy().into_owned(),
            harness_version: harness_version.clone(),
            argv: options.argv.clone(),
        },
    ) {
        Ok(guard) => guard,
        Err(owner) => {
            log(&format!(
                "mcp-optimizer worker: already running{}",
                owner
                    .map(|owner| format!(" (pid {})", owner.pid))
                    .unwrap_or_default()
            ));
            return Ok(0);
        }
    };

    let prior = read_worker_state(&version_directory).or_else(|| read_worker_state(&directory));
    let runtime = WorkerRuntime {
        root: root.clone(),
        owner_state_dir: owner_state_dir.clone(),
        directory: directory.clone(),
        version_directory,
        version_control_directory,
        harness_version: harness_version.clone(),
        argv: options.argv.clone(),
        started_at: now_iso(),
        settings: read_settings(&directory),
        stopping: false,
        draining: false,
        last_run_at: prior.as_ref().and_then(|state| state.last_run_at.clone()),
        next_run_at: prior.as_ref().and_then(|state| state.next_run_at.clone()),
        last_error: None,
        notice: None,
    };
    let runtime = Arc::new(Mutex::new(runtime));

    {
        let mut state = runtime.lock().expect("the worker runtime");
        state.publish(Lifecycle::Running, true);
        if state.next_run_at.is_none() {
            state.recompute_next();
        }
    }

    // One control consumer runs beside the cycle: a drain written while a
    // cycle is in flight must reach the worker before that cycle finishes.
    let control_runtime = runtime.clone();
    let control_alive = Arc::new(AtomicBool::new(true));
    let control_flag = control_alive.clone();
    let control_task = tokio::spawn(async move {
        while control_flag.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(control_poll_ms)).await;
            if !control_flag.load(Ordering::SeqCst) {
                break;
            }
            if let Ok(mut state) = control_runtime.lock() {
                state.consume();
            }
        }
    });

    let signal_runtime = runtime.clone();
    let signal_task = tokio::spawn(async move {
        #[cfg(unix)]
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).ok();
        #[cfg(unix)]
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = async {
                match &mut terminate {
                    Some(stream) => {
                        stream.recv().await;
                    }
                    None => std::future::pending::<()>().await,
                }
            } => {}
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
        if let Ok(mut state) = signal_runtime.lock() {
            state.request_stop();
        }
    });

    loop {
        let (stopping, draining, next) = {
            let mut state = runtime.lock().expect("the worker runtime");
            state.consume();
            (state.stopping, state.draining, state.next_run_at.clone())
        };
        if stopping || draining {
            break;
        }
        let now = now_millis();
        let due = match next.as_deref().and_then(parse_instant_millis) {
            Some(next) => now >= next,
            None => true,
        };
        if due {
            {
                let state = runtime.lock().expect("the worker runtime");
                let _ = &state.settings;
            }
            let settings = read_settings(&directory);
            if let Ok(mut state) = runtime.lock() {
                state.settings = settings.clone();
            }
            // One cycle at a time across every version: the lease is held only
            // for the cycle, so a drained worker's in-flight unit is never
            // re-run by its replacement.
            let lease = acquire_lock(
                &cycle_lock_path(&directory),
                &LockDetails {
                    repo: root.to_string_lossy().into_owned(),
                    state_dir: owner_state_dir.to_string_lossy().into_owned(),
                    harness_version: harness_version.clone(),
                    argv: options.argv.clone(),
                },
            );
            let lease = match lease {
                Ok(guard) => guard,
                Err(_) => {
                    if let Ok(mut state) = runtime.lock() {
                        state.notice = Some(CYCLE_BUSY_NOTICE.to_string());
                        state.next_run_at = Some(iso(from_millis(now + control_poll_ms as i64)));
                        state.publish(Lifecycle::Running, true);
                    }
                    continue;
                }
            };
            {
                let mut state = runtime.lock().expect("the worker runtime");
                let last_run_at = now_iso();
                state.next_run_at = parse_instant_millis(&last_run_at)
                    .map(|started| iso(from_millis(started + state.cadence_ms() as i64)));
                state.last_run_at = Some(last_run_at);
                state.notice = None;
                state.publish(Lifecycle::Running, true);
            }
            let outcome = cycle
                .run(CycleOptions {
                    root: root.clone(),
                    state_dir: state_dir.clone(),
                    now: None,
                    dry_run: false,
                    settings: Some(settings),
                    environment: std::env::vars().collect(),
                    collect: None,
                    delivery: None,
                    open_issues: None,
                    synthesize: None,
                })
                .await;
            match outcome {
                Ok(result) => {
                    if let Ok(mut state) = runtime.lock() {
                        state.last_error = if result.report.action == "failed" {
                            result.report.reason.clone()
                        } else {
                            None
                        };
                        state.notice = result.report.reason.clone();
                    }
                    log(&describe_cycle(&result));
                }
                Err(error) => {
                    if let Ok(mut state) = runtime.lock() {
                        state.last_error = Some(error_line(&error));
                    }
                }
            }
            drop(lease);
            let (stopping, draining) = {
                let mut state = runtime.lock().expect("the worker runtime");
                state.consume();
                (state.stopping, state.draining)
            };
            if stopping || draining {
                break;
            }
            let mut state = runtime.lock().expect("the worker runtime");
            state.settings = read_settings(&directory);
            state.recompute_next();
            state.publish(Lifecycle::Running, true);
            continue;
        }
        let wait = next
            .as_deref()
            .and_then(parse_instant_millis)
            .map(|next| std::cmp::max(1, next - now) as u64)
            .unwrap_or(control_poll_ms);
        tokio::time::sleep(Duration::from_millis(std::cmp::min(
            control_poll_ms,
            std::cmp::max(1, wait),
        )))
        .await;
    }

    control_alive.store(false, Ordering::SeqCst);
    control_task.abort();
    signal_task.abort();
    {
        let mut state = runtime.lock().expect("the worker runtime");
        state.consume();
        state.publish(Lifecycle::Stopped, false);
    }
    drop(lock);
    Ok(0)
}

// ---------------------------------------------------------------------------
// The forge projection

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectedIssue {
    pub url: String,
    /// `pending`, `implemented`, or `unreadable`.
    pub state: String,
    pub version: Option<String>,
}

/// The last forge projection the dashboard computed, persisted where the
/// worker can read it. A cap counts open state only from this file and files
/// nothing new while its sync is not `ok`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Projection {
    pub state: String,
    pub at: Option<String>,
    pub error: Option<String>,
    pub issues: Vec<ProjectedIssue>,
}

impl Projection {
    pub fn to_json(&self) -> Value {
        let mut record = Map::new();
        record.insert("version".into(), Value::from(PROJECTION_VERSION));
        record.insert("state".into(), Value::from(self.state.clone()));
        record.insert(
            "at".into(),
            self.at.clone().map(Value::from).unwrap_or(Value::Null),
        );
        record.insert(
            "error".into(),
            self.error.clone().map(Value::from).unwrap_or(Value::Null),
        );
        record.insert(
            "issues".into(),
            Value::Array(
                self.issues
                    .iter()
                    .map(|issue| {
                        json!({
                            "url": issue.url,
                            "state": issue.state,
                            "version": issue.version,
                        })
                    })
                    .collect(),
            ),
        );
        Value::Object(record)
    }
}

pub fn read_projection(directory: &Path) -> Option<Projection> {
    let parsed = read_json(&projection_path(directory))?;
    let record = record(&parsed)?;
    if record.get("version").and_then(Value::as_u64) != Some(PROJECTION_VERSION) {
        return None;
    }
    let state = record.get("state")?.as_str()?;
    if !matches!(state, "ok" | "error" | "stale") {
        return None;
    }
    let at = match record.get("at")? {
        Value::Null => None,
        Value::String(value) => Some(value.clone()),
        _ => return None,
    };
    let error = match record.get("error")? {
        Value::Null => None,
        Value::String(value) => Some(value.clone()),
        _ => return None,
    };
    let mut issues = Vec::new();
    for entry in record.get("issues")?.as_array()? {
        let Some(entry) = entry.as_object() else {
            continue;
        };
        let Some(url) = entry.get("url").and_then(Value::as_str) else {
            continue;
        };
        let Some(state) = entry.get("state").and_then(Value::as_str) else {
            continue;
        };
        if !matches!(state, "pending" | "implemented" | "unreadable") {
            continue;
        }
        let version = match entry.get("version") {
            Some(Value::Null) => None,
            Some(Value::String(value)) => Some(value.clone()),
            _ => continue,
        };
        issues.push(ProjectedIssue {
            url: url.to_string(),
            state: state.to_string(),
            version,
        });
    }
    Some(Projection {
        state: state.to_string(),
        at,
        error,
        issues,
    })
}

pub fn write_projection(directory: &Path, projection: &Projection) -> std::io::Result<()> {
    write_json_atomic(&projection_path(directory), &projection.to_json())
}

pub type IssueReaderFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Vec<ProjectedIssue>, String>> + Send + 'a>>;

/// The dashboard's read of each filed issue's forge state.
pub trait IssueReader: Send + Sync {
    fn project<'a>(&'a self, urls: &[String]) -> IssueReaderFuture<'a>;
}

/// The production reader: one forge call per projection.
pub struct NativeIssueReader {
    origin: OriginRemote,
    environment: HashMap<String, String>,
}

impl IssueReader for NativeIssueReader {
    fn project<'a>(&'a self, urls: &[String]) -> IssueReaderFuture<'a> {
        let urls = urls.to_vec();
        Box::pin(async move {
            let states: HashMap<String, String> = match self.origin.forge {
                ForgeKind::GitHub => {
                    let output = std::process::Command::new("gh")
                        .args([
                            "issue",
                            "list",
                            "--state",
                            "all",
                            "--limit",
                            "1000",
                            "--json",
                            "state,url",
                        ])
                        .output()
                        .map_err(|error| error.to_string())?;
                    if !output.status.success() {
                        return Err(first_line(&String::from_utf8_lossy(&output.stderr)));
                    }
                    let parsed: Value = serde_json::from_slice(&output.stdout)
                        .map_err(|error| error.to_string())?;
                    parsed
                        .as_array()
                        .map(|entries| {
                            entries
                                .iter()
                                .filter_map(|entry| {
                                    let record = entry.as_object()?;
                                    let url = record.get("url")?.as_str()?.to_string();
                                    let state = record.get("state")?.as_str()?;
                                    Some((
                                        url,
                                        if state == "OPEN" {
                                            "pending"
                                        } else {
                                            "implemented"
                                        }
                                        .to_string(),
                                    ))
                                })
                                .collect()
                        })
                        .unwrap_or_default()
                }
                ForgeKind::Gitea => {
                    let base = self
                        .environment
                        .get("DEVBOARD_GITEA_URL")
                        .filter(|value| !value.trim().is_empty())
                        .cloned()
                        .or_else(|| self.origin.origin_url.clone())
                        .ok_or_else(|| "the Gitea address is not configured".to_string())?;
                    let token = self
                        .environment
                        .get("GITEA_TOKEN")
                        .cloned()
                        .ok_or_else(|| "GITEA_TOKEN is not set".to_string())?;
                    let response = reqwest::Client::new()
                        .get(format!(
                            "{base}/api/v1/repos/{}/issues?state=all&limit=1000",
                            self.origin.project
                        ))
                        .header("Authorization", format!("token {token}"))
                        .send()
                        .await
                        .map_err(|error| error.to_string())?;
                    if !response.status().is_success() {
                        return Err(response.status().to_string());
                    }
                    let parsed: Value = response.json().await.map_err(|error| error.to_string())?;
                    parsed
                        .as_array()
                        .map(|entries| {
                            entries
                                .iter()
                                .filter_map(|entry| {
                                    let record = entry.as_object()?;
                                    let url = record.get("html_url")?.as_str()?.to_string();
                                    let state = record.get("state")?.as_str()?;
                                    Some((
                                        url,
                                        if state == "open" {
                                            "pending"
                                        } else {
                                            "implemented"
                                        }
                                        .to_string(),
                                    ))
                                })
                                .collect()
                        })
                        .unwrap_or_default()
                }
                ForgeKind::GitLab => {
                    return Err(
                        "MCP optimizer supports a GitHub or Gitea origin, not a GitLab one"
                            .to_string(),
                    )
                }
            };
            Ok(urls
                .iter()
                .map(|url| ProjectedIssue {
                    url: url.clone(),
                    state: states
                        .get(url)
                        .cloned()
                        .unwrap_or_else(|| "unreadable".to_string()),
                    version: None,
                })
                .collect())
        })
    }
}

// ---------------------------------------------------------------------------
// The dashboard's MCP optimizer bridge

/// The result one lifecycle command reports to the dashboard.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandResult {
    pub ok: bool,
    pub message: Option<String>,
}

impl CommandResult {
    pub fn ok() -> Self {
        Self {
            ok: true,
            message: None,
        }
    }

    pub fn refused(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            message: Some(message.into()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Preflight {
    Ok,
    Refused(String),
}

pub type PreflightFn = Arc<
    dyn Fn(&Path, &HashMap<String, String>) -> Pin<Box<dyn Future<Output = Preflight> + Send>>
        + Send
        + Sync,
>;
pub type SpawnWorkerFn =
    Arc<dyn Fn(&[String], &HashMap<String, String>) -> Option<u32> + Send + Sync>;

pub struct ActivityOptions {
    pub repo_dir: PathBuf,
    /// This dashboard's STATE_DIR; MCP optimizer files live under its `coach/`.
    pub state_dir: PathBuf,
    pub harness_dir: PathBuf,
    /// The harness version this dashboard loaded, for parallel-worker takeover.
    pub running_version: Option<String>,
    pub environment: HashMap<String, String>,
    /// Test seam; production derives it from the state directory.
    pub directory: Option<PathBuf>,
    pub reader: Option<Arc<dyn IssueReader>>,
    /// True while at least one dashboard client is connected.
    pub has_clients: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    pub now: Option<Arc<dyn Fn() -> i64 + Send + Sync>>,
    pub interval_ms: Option<i64>,
    pub stale_after_ms: Option<i64>,
    pub log: Option<Arc<dyn Fn(&str) + Send + Sync>>,
    pub preflight: Option<PreflightFn>,
    pub spawn_worker: Option<SpawnWorkerFn>,
}

const START_PROOF_MS: i64 = 5_000;
const STOP_CYCLE_GRACE_MS: u64 = 10 * 60_000;
const STOP_KILL_GRACE_MS: u64 = 2_000;
const AGENT_FORGE_INTERVAL_MS: i64 = 60_000;
const AGENT_FORGE_STALE_MS: i64 = 120_000;

/// The MCP optimizer page's server half: it reads the detached worker's state,
/// overlays the forge projection that the filing caps count, and starts or
/// stops the worker. A page load, a reconnect, or a dashboard restart only
/// reads; it never starts a cycle.
pub struct Activity {
    repo_dir: PathBuf,
    state_dir: PathBuf,
    directory: PathBuf,
    running_version: Option<String>,
    environment: HashMap<String, String>,
    reader: Arc<dyn IssueReader>,
    has_clients: Arc<dyn Fn() -> bool + Send + Sync>,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    interval_ms: i64,
    stale_after_ms: i64,
    log: Arc<dyn Fn(&str) + Send + Sync>,
    preflight: PreflightFn,
    spawn_worker: SpawnWorkerFn,
    rows: Vec<(String, ProjectedIssue)>,
    sync_state: String,
    sync_at: Option<String>,
    sync_error: Option<String>,
    starting: bool,
    starting_since: Option<i64>,
    stop_requested: bool,
    start_error: Option<String>,
    notice: Option<String>,
    takeover_done: bool,
}

impl Activity {
    pub fn new(options: ActivityOptions) -> Self {
        let repo_dir = resolve(&options.repo_dir);
        let state_dir = resolve(&options.state_dir);
        let directory = options
            .directory
            .clone()
            .map(|directory| resolve(&directory))
            .unwrap_or_else(|| mcp_optimizer_directory(&state_dir));
        let environment = options.environment.clone();
        let reader = options
            .reader
            .clone()
            .unwrap_or_else(|| match origin_remote(&repo_dir) {
                Some(origin) => Arc::new(NativeIssueReader {
                    origin,
                    environment: environment.clone(),
                }),
                None => Arc::new(MissingReader),
            });
        let seeded = read_projection(&directory)
            .map(|projection| projection.issues)
            .unwrap_or_default();
        let preflight: PreflightFn = options.preflight.clone().unwrap_or_else(|| {
            Arc::new(|repo_dir: &Path, environment: &HashMap<String, String>| {
                let repo_dir = repo_dir.to_path_buf();
                let environment = environment.clone();
                Box::pin(async move { preflight_mcp_optimizer(&repo_dir, &environment).await })
            })
        });
        let log = options
            .log
            .clone()
            .unwrap_or_else(|| Arc::new(|_: &str| {}));
        let spawn_worker = options.spawn_worker.clone().unwrap_or_else(|| {
            let log = log.clone();
            let state_dir = state_dir.clone();
            let repo_dir = repo_dir.clone();
            Arc::new(
                move |argv: &[String], environment: &HashMap<String, String>| {
                    crate::supervision::supervised_detach(
                        argv,
                        crate::supervision::SupervisedDetachOptions {
                            cwd: repo_dir.clone(),
                            env: environment.clone(),
                            state_dir: Some(state_dir.clone()),
                            stdio: crate::supervision::DetachStdio::ignore(),
                            on_error: {
                                let log = log.clone();
                                let sink: crate::supervision::SpawnErrorSink =
                                    Box::new(move |error: &std::io::Error| {
                                        log(&format!(
                                            "could not start the MCP optimizer worker: {error}"
                                        ));
                                    });
                                Some(sink)
                            },
                        },
                    )
                },
            )
        });
        Self {
            repo_dir,
            state_dir,
            directory,
            running_version: options.running_version,
            environment,
            reader,
            has_clients: options
                .has_clients
                .clone()
                .unwrap_or_else(|| Arc::new(|| false)),
            now: options.now.clone().unwrap_or_else(|| Arc::new(now_millis)),
            interval_ms: options.interval_ms.unwrap_or(AGENT_FORGE_INTERVAL_MS),
            stale_after_ms: options.stale_after_ms.unwrap_or(AGENT_FORGE_STALE_MS),
            log,
            preflight,
            spawn_worker,
            rows: seeded
                .into_iter()
                .map(|issue| (issue.url.clone(), issue))
                .collect(),
            sync_state: "stale".to_string(),
            sync_at: None,
            sync_error: None,
            starting: false,
            starting_since: None,
            stop_requested: false,
            start_error: None,
            notice: None,
            takeover_done: false,
        }
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    /// Syncs and publishes the projection, then starts the newest harness's
    /// worker when an older version's worker is live.
    pub async fn begin(&mut self) {
        self.sync_now().await;
        self.takeover_old_workers().await;
    }

    pub fn dispose(&mut self) {
        self.stop_requested = false;
    }

    pub async fn settled(&mut self) {}

    /// A view opened this agent: read the forge now when the cadence allows.
    pub async fn request_sync(&mut self) {
        let last = self.sync_at.as_deref().and_then(parse_instant_millis);
        let due = match last {
            Some(last) => (self.now)() - last >= self.interval_ms,
            None => true,
        };
        if due {
            self.sync_now().await;
        }
    }

    async fn sync_now(&mut self) {
        let mut urls: Vec<String> = self.rows.iter().map(|(url, _)| url.clone()).collect();
        if urls.is_empty() {
            urls = load_ledger(&self.directory)
                .ledger
                .families
                .iter()
                .filter_map(|(_, entry)| entry.last_issue_url.clone())
                .collect();
        }
        if urls.is_empty() {
            self.sync_state = "ok".to_string();
            self.sync_at = Some(iso(from_millis((self.now)())));
            self.sync_error = None;
            if self.should_persist_projection() {
                self.persist_projection();
            }
            return;
        }
        match self.reader.project(&urls).await {
            Ok(projected) => {
                for issue in projected {
                    match self.rows.iter_mut().find(|(url, _)| url == &issue.url) {
                        Some((_, existing)) => *existing = issue,
                        None => self.rows.push((issue.url.clone(), issue)),
                    }
                }
                self.sync_state = "ok".to_string();
                self.sync_at = Some(iso(from_millis((self.now)())));
                self.sync_error = None;
            }
            Err(error) => {
                self.sync_state = "error".to_string();
                self.sync_error = Some(error);
            }
        }
        // A read still scheduled by a connected view is the fresh one; with no
        // client the row keeps its last successful read time and ages out.
        let _connected = (self.has_clients)();
        if let Some(at) = self.sync_at.as_deref().and_then(parse_instant_millis) {
            if self.sync_state == "ok" && (self.now)() - at > self.stale_after_ms {
                self.sync_state = "stale".to_string();
            }
        }
        if self.should_persist_projection() {
            self.persist_projection();
        }
    }

    fn should_persist_projection(&self) -> bool {
        if !self.all_states().is_empty() {
            return true;
        }
        let settings = read_settings(&self.directory);
        settings.max_per_hour.is_some() || settings.max_pending.is_some()
    }

    fn persist_projection(&self) {
        let projection = Projection {
            state: self.sync_state.clone(),
            at: self.sync_at.clone(),
            error: self.sync_error.clone(),
            issues: self.rows.iter().map(|(_, fact)| fact.clone()).collect(),
        };
        if let Err(error) = write_projection(&self.directory, &projection) {
            (self.log)(&format!(
                "could not persist the MCP optimizer projection: {error}"
            ));
        }
    }

    /// Every published worker state: the legacy file and each version's file.
    fn all_states(&self) -> Vec<WorkerState> {
        let mut states = Vec::new();
        if let Some(legacy) = read_worker_state(&self.directory) {
            states.push(legacy);
        }
        for directory in worker_state_directories(&self.directory) {
            if let Some(state) = read_worker_state(&directory) {
                states.push(state);
            }
        }
        states
    }

    /// Live owners of this family whose STATE_DIR is this dashboard's.
    fn owners(&self) -> Vec<LockOwner> {
        live_lock_owners(&lock_path(&self.directory))
            .into_iter()
            .filter(|owner| resolve(Path::new(&owner.state_dir)) == self.state_dir)
            .collect()
    }

    /// The control directory one live owner consumes, legacy or versioned.
    fn control_for(&self, owner: &LockOwner) -> PathBuf {
        let legacy = read_lock(&lock_path(&self.directory));
        if let Some(legacy) = legacy {
            if legacy.pid == owner.pid {
                return control_directory(&self.directory);
            }
        }
        versioned_control_directory(&self.directory, owner.harness_version.as_deref())
    }

    fn lifecycles(&self) -> (Vec<WorkerState>, Vec<LockOwner>, bool) {
        let owners = self.owners();
        let states = self.all_states();
        let mut owner_states = Vec::new();
        for owner in &owners {
            if let Some(state) = states.iter().find(|state| state.pid == owner.pid) {
                owner_states.push(state.clone());
            }
        }
        let attached = owners.iter().enumerate().any(|(index, _)| {
            owner_states
                .get(index)
                .map(|state| state.lifecycle != Lifecycle::Stopped)
                .unwrap_or(true)
        });
        (states, owners, attached)
    }

    pub async fn snapshot(&mut self) -> Value {
        self.request_sync().await;
        let (states, owners, attached) = self.lifecycles();
        let active = {
            let running = states
                .iter()
                .find(|state| state.lifecycle != Lifecycle::Stopped)
                .cloned();
            running.or_else(|| {
                let mut sorted = states.clone();
                sorted.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
                sorted.first().cloned()
            })
        };
        if self.starting && attached {
            self.starting = false;
            self.starting_since = None;
        }
        if attached {
            self.start_error = None;
        }
        if self.starting
            && self
                .starting_since
                .map(|since| (self.now)() - since > START_PROOF_MS)
                .unwrap_or(false)
        {
            self.starting = false;
            self.starting_since = None;
            self.start_error = Some(
                "the MCP optimizer worker did not publish its state within 5 seconds".to_string(),
            );
        }
        if self.stop_requested && !attached {
            self.stop_requested = false;
        }
        let status = read_status(&self.directory);
        let settings = read_settings(&self.directory);
        let lifecycle = if self.starting {
            "starting".to_string()
        } else if self.stop_requested
            || active
                .as_ref()
                .map(|state| state.lifecycle == Lifecycle::Stopping)
                .unwrap_or(false)
        {
            "stopping".to_string()
        } else if attached {
            if active.as_ref().map(|state| state.lifecycle) == Some(Lifecycle::Failed) {
                "failed".to_string()
            } else {
                "running".to_string()
            }
        } else if active.as_ref().map(|state| state.lifecycle) == Some(Lifecycle::Failed) {
            "failed".to_string()
        } else {
            "stopped".to_string()
        };
        let enabled = attached
            && active.as_ref().map(|state| state.enabled).unwrap_or(false)
            && lifecycle != "stopped";
        let workers: Vec<Value> = owners
            .iter()
            .map(|owner| {
                json!({
                    "pid": owner.pid,
                    "version": owner.harness_version,
                    "stateDir": owner.state_dir,
                    "lifecycle": states
                        .iter()
                        .find(|state| state.pid == owner.pid)
                        .map(|state| state.lifecycle.as_str())
                        .unwrap_or("running"),
                })
            })
            .collect();
        let issue_rows: Vec<Value> = status
            .issues
            .iter()
            .filter(|issue| self.rows.iter().any(|(url, _)| url == &issue.url))
            .map(|issue| {
                let fact = self
                    .rows
                    .iter()
                    .find(|(url, _)| url == &issue.url)
                    .map(|(_, fact)| fact.clone());
                json!({
                    "title": issue.title,
                    "category": issue.kind.as_str(),
                    "filedAt": issue.filed_at,
                    "url": issue.url,
                    "state": fact.as_ref().map(|fact| fact.state.clone()).unwrap_or_else(|| "unknown".to_string()),
                    "version": fact.and_then(|fact| fact.version),
                })
            })
            .collect();
        let last_run_at = active
            .as_ref()
            .and_then(|state| state.last_run_at.clone())
            .or(status.cycle.clone());
        let next_run_at = if attached {
            active.as_ref().and_then(|state| state.next_run_at.clone())
        } else {
            None
        };
        let notice = active
            .as_ref()
            .and_then(|state| state.notice.clone())
            .or_else(|| self.notice.clone());
        let error = self
            .start_error
            .clone()
            .or_else(|| active.as_ref().and_then(|state| state.last_error.clone()));
        json!({
            "lifecycle": lifecycle,
            "enabled": enabled,
            "owned": attached,
            "attached": attached,
            "cadence": {
                "minutes": settings.interval_minutes,
                "lastRunAt": last_run_at,
                "nextRunAt": next_run_at,
            },
            "limits": {
                "maxPerHour": settings.max_per_hour,
                "maxPending": settings.max_pending,
            },
            "issues": issue_rows,
            "pending": status.pending,
            "sync": {
                "state": self.sync_state,
                "at": self.sync_at,
                "error": self.sync_error,
            },
            "detail": { "panel": "cycles", "cycles": status.cycles },
            "notice": notice,
            "error": error,
            "timer": Value::Null,
            "workers": workers,
        })
    }

    pub async fn start(&mut self) -> CommandResult {
        if self.starting {
            return CommandResult::ok();
        }
        // Any live worker of this family already serves new cycles, whichever
        // version started it; Start never duplicates one.
        if !self.owners().is_empty() {
            self.request_sync().await;
            return CommandResult::ok();
        }
        self.spawn().await
    }

    /// Starts this version's worker when an older version's worker is live and
    /// this process is the newest harness. The older worker is told to drain.
    /// Runs once per bridge lifetime; with no live worker nothing starts.
    async fn takeover_old_workers(&mut self) {
        if self.takeover_done {
            return;
        }
        self.takeover_done = true;
        let owners = self.owners();
        if owners.is_empty() {
            return;
        }
        let Some(running_version) = self.running_version.clone() else {
            return;
        };
        let newest =
            crate::version::read_harness_version(&crate::version::host_harness_dir(&self.repo_dir));
        if newest.as_deref() != Some(running_version.as_str()) {
            return;
        }
        if owners
            .iter()
            .any(|owner| owner.harness_version.as_deref() == Some(running_version.as_str()))
        {
            return;
        }
        let started = self.spawn().await;
        if !started.ok {
            (self.log)(&format!(
                "could not start the {} MCP optimizer worker: {}",
                running_version,
                started.message.unwrap_or_default()
            ));
            return;
        }
        for owner in owners {
            if owner.harness_version.as_deref() == Some(running_version.as_str()) {
                continue;
            }
            let directory = self.control_for(&owner);
            if let Err(error) = write_command(&directory, &Command::Drain) {
                (self.log)(&format!(
                    "could not drain the {} MCP optimizer worker: {error}",
                    owner
                        .harness_version
                        .clone()
                        .unwrap_or_else(|| "legacy".to_string())
                ));
            }
        }
    }

    /// Spawns the newest harness's worker after the Start preflight.
    async fn spawn(&mut self) -> CommandResult {
        self.starting = true;
        // The proof measures the worker's own publication, so its clock starts
        // when the worker is spawned.
        self.starting_since = None;
        self.start_error = None;
        self.notice = None;
        let preflight = (self.preflight)(&self.repo_dir, &self.environment).await;
        if let Preflight::Refused(message) = preflight {
            self.starting = false;
            self.starting_since = None;
            self.start_error = Some(message.clone());
            return CommandResult::refused(message);
        }
        let argv: Vec<String> = vec![
            crate::relaunch::own_program().to_string_lossy().into_owned(),
            "worker".to_string(),
            "mcp-optimizer".to_string(),
            "--repo".to_string(),
            self.repo_dir.to_string_lossy().into_owned(),
            "--state-dir".to_string(),
            self.state_dir.to_string_lossy().into_owned(),
        ];
        self.starting_since = Some((self.now)());
        let mut environment = self.environment.clone();
        environment.insert(
            "REPO_DIR".to_string(),
            self.repo_dir.to_string_lossy().into_owned(),
        );
        let pid = (self.spawn_worker)(&argv, &environment);
        if pid.is_none() {
            self.starting = false;
            self.starting_since = None;
            self.start_error = Some("the MCP optimizer worker could not be started".to_string());
            return CommandResult::refused("the MCP optimizer worker could not be started");
        }
        self.request_sync().await;
        CommandResult::ok()
    }

    pub fn stop(&mut self) -> CommandResult {
        let owners = self.owners();
        if owners.is_empty() {
            return CommandResult::refused(
                "No MCP optimizer worker is running for this repository.",
            );
        }
        let mut failures: Vec<String> = Vec::new();
        for owner in &owners {
            let directory = self.control_for(owner);
            match write_command(&directory, &Command::Stop) {
                Ok(_) => {
                    self.stop_requested = true;
                    self.schedule_stop_proof(owner.pid);
                }
                Err(error) => failures.push(error.to_string()),
            }
        }
        self.start_error = None;
        if !failures.is_empty() {
            return CommandResult::refused(format!(
                "Could not reach every worker: {}",
                failures.join("; ")
            ));
        }
        CommandResult::ok()
    }

    fn schedule_stop_proof(&mut self, pid: u32) {
        // The dashboard sends SIGTERM, then SIGKILL, to a worker that has not
        // published `stopped` after the cycle grace period.
        let directory = self.directory.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(STOP_CYCLE_GRACE_MS));
            if stop_settled(&directory, pid) {
                return;
            }
            let _ = unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
            std::thread::sleep(Duration::from_millis(STOP_KILL_GRACE_MS));
            if stop_settled(&directory, pid) {
                return;
            }
            let _ = unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
        });
    }

    pub fn set_settings(
        &mut self,
        minutes: Option<i64>,
        max_per_hour: Option<i64>,
        max_pending: Option<i64>,
    ) -> CommandResult {
        let Some(minutes) = minutes.filter(|value| (1..=1440).contains(value)) else {
            return CommandResult::refused(
                "The cadence must be an integer from 1 through 1440 minutes.",
            );
        };
        let valid_limit = |value: Option<i64>| {
            value
                .map(|value| (1..=100).contains(&value))
                .unwrap_or(true)
        };
        if !valid_limit(max_per_hour) || !valid_limit(max_pending) {
            return CommandResult::refused(
                "Both limits must be empty or integers from 1 through 100.",
            );
        }
        let mut settings = read_settings(&self.directory);
        settings.interval_minutes = minutes as u32;
        settings.max_per_hour = max_per_hour.map(|value| value as u32);
        settings.max_pending = max_pending.map(|value| value as u32);
        if let Err(error) = write_settings(&self.directory, &settings) {
            return CommandResult::refused(format!("Could not save the settings: {error}"));
        }
        let mut failures: Vec<String> = Vec::new();
        for owner in &self.owners() {
            let directory = self.control_for(owner);
            match write_command(
                &directory,
                &Command::Settings {
                    interval_minutes: minutes as u32,
                    max_per_hour: max_per_hour.map(|value| value as u32),
                    max_pending: max_pending.map(|value| value as u32),
                },
            ) {
                Ok(_) => {}
                Err(error) => failures.push(error.to_string()),
            }
        }
        self.start_error = None;
        if self.should_persist_projection() {
            self.persist_projection();
        }
        if !failures.is_empty() {
            return CommandResult::refused(format!(
                "Could not reach every worker: {}",
                failures.join("; ")
            ));
        }
        CommandResult::ok()
    }
}

struct MissingReader;

impl IssueReader for MissingReader {
    fn project<'a>(&'a self, urls: &[String]) -> IssueReaderFuture<'a> {
        let urls = urls.to_vec();
        Box::pin(async move {
            Ok(urls
                .into_iter()
                .map(|url| ProjectedIssue {
                    url,
                    state: "unreadable".to_string(),
                    version: None,
                })
                .collect())
        })
    }
}

fn stop_settled(directory: &Path, pid: u32) -> bool {
    if !pid_alive(pid) {
        return true;
    }
    let mut states = Vec::new();
    if let Some(legacy) = read_worker_state(directory) {
        states.push(legacy);
    }
    for child in worker_state_directories(directory) {
        if let Some(state) = read_worker_state(&child) {
            states.push(state);
        }
    }
    states
        .iter()
        .find(|state| state.pid == pid)
        .map(|state| state.lifecycle == Lifecycle::Stopped)
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Start preflight

fn find_on_path(name: &str, environment: &HashMap<String, String>) -> Option<PathBuf> {
    let path = environment.get("PATH")?;
    for entry in path.split(':') {
        if entry.is_empty() {
            continue;
        }
        let candidate = Path::new(entry).join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// MCP optimizer's Start preflight: a supported origin and a write-capable
/// account for the delivery. It names the missing fact, writes no state, and
/// spawns nothing.
pub async fn preflight_mcp_optimizer(
    repo_dir: &Path,
    environment: &HashMap<String, String>,
) -> Preflight {
    let top = std::process::Command::new("git")
        .arg("-C")
        .arg(repo_dir)
        .args(["rev-parse", "--show-toplevel"])
        .output();
    match top {
        Ok(output) if output.status.success() => {}
        _ => {
            return Preflight::Refused(format!(
                "{} is not inside a git checkout",
                repo_dir.display()
            ))
        }
    }
    let Some(remote) = origin_remote(repo_dir) else {
        return Preflight::Refused(
            "the checkout's origin does not name a supported repository".to_string(),
        );
    };
    if remote.forge == ForgeKind::GitLab {
        return Preflight::Refused(format!(
            "MCP optimizer supports a GitHub or Gitea origin, not a GitLab one: {}",
            remote.host
        ));
    }
    if remote.forge == ForgeKind::GitHub {
        if find_on_path("gh", environment).is_none() {
            return Preflight::Refused("missing prerequisite: gh is not on PATH".to_string());
        }
        let mut command = std::process::Command::new("gh");
        command
            .args([
                "api",
                &format!("repos/{}", remote.project),
                "--jq",
                ".permissions.push",
            ])
            .env_clear();
        for (key, value) in environment {
            command.env(key, value);
        }
        let output = command.output();
        let (code, stdout, stderr) = match output {
            Ok(output) => (
                output.status.code().unwrap_or(-1),
                String::from_utf8_lossy(&output.stdout).into_owned(),
                String::from_utf8_lossy(&output.stderr).into_owned(),
            ),
            Err(error) => (-1, String::new(), error.to_string()),
        };
        if code != 0 || stdout.trim() != "true" {
            let stderr_line = first_line(&stderr);
            let detail = if stderr_line != "no diagnostic" {
                stderr_line
            } else {
                let stdout_line = first_line(&stdout);
                if stdout_line != "no diagnostic" {
                    stdout_line
                } else {
                    format!("gh exited with code {code}")
                }
            };
            return Preflight::Refused(format!(
                "missing prerequisite: 'gh api repos/{} --jq .permissions.push' did not return true: {detail}",
                remote.project
            ));
        }
        return Preflight::Ok;
    }
    let base = environment
        .get("DEVBOARD_GITEA_URL")
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim_end_matches('/').to_string())
        .or_else(|| remote.origin_url.clone());
    let Some(base) = base else {
        return Preflight::Refused(
            "missing prerequisite: the Gitea address is not configured (set DEVBOARD_GITEA_URL or use an HTTP(S) origin)"
                .to_string(),
        );
    };
    let Some(token) = environment
        .get("GITEA_TOKEN")
        .filter(|value| !value.is_empty())
    else {
        return Preflight::Refused("missing prerequisite: GITEA_TOKEN is not set".to_string());
    };
    let response = reqwest::Client::new()
        .get(format!("{base}/api/v1/repos/{}", remote.project))
        .header("Authorization", format!("token {token}"))
        .send()
        .await;
    match response {
        Ok(response) if response.status().is_success() => {
            let document: Value = response.json().await.unwrap_or(Value::Null);
            let permissions = document.get("permissions");
            let writable = permissions
                .and_then(|value| value.get("push"))
                .and_then(Value::as_bool)
                == Some(true)
                || permissions
                    .and_then(|value| value.get("admin"))
                    .and_then(Value::as_bool)
                    == Some(true);
            if !writable {
                return Preflight::Refused(format!(
                    "missing prerequisite: the Gitea token cannot write to {} on {base}",
                    remote.project
                ));
            }
            Preflight::Ok
        }
        Ok(response) => Preflight::Refused(format!(
            "missing prerequisite: the Gitea repository {} could not be read: {}",
            remote.project,
            response.status()
        )),
        Err(error) => Preflight::Refused(format!(
            "missing prerequisite: the Gitea repository {} could not be read: {error}",
            remote.project
        )),
    }
}

// ---------------------------------------------------------------------------
// Worker entry

/// The family entry point: `devboard worker mcp-optimizer --repo <dir>
/// --state-dir <dir> [--owner-state-dir <dir>]`.
pub async fn run(invocation: &WorkerInvocation) -> anyhow::Result<()> {
    let root = resolve(&invocation.repo_dir);
    if !root.join(".devboard").is_dir() {
        eprintln!(
            "mcp-optimizer worker: missing prerequisite: {} does not exist",
            root.join(".devboard").display()
        );
        std::process::exit(2);
    }
    let state_dir = if invocation.state_dir.as_os_str().is_empty() {
        root.join(".devboard").join(".tmp")
    } else {
        invocation.state_dir.clone()
    };
    let owner_state_dir = invocation
        .option("owner-state-dir")
        .map(PathBuf::from)
        .unwrap_or_else(|| state_dir.clone());
    let once = invocation.rest.iter().any(|flag| flag == "--once");
    let collect = invocation.rest.iter().any(|flag| flag == "--collect");
    let dry_run = invocation.rest.iter().any(|flag| flag == "--dry-run");
    let json = invocation.rest.iter().any(|flag| flag == "--json");
    if once || collect || dry_run {
        if collect && !dry_run {
            eprintln!("mcp-optimizer: --collect runs with --dry-run");
            std::process::exit(2);
        }
        if once && (collect || dry_run) {
            eprintln!("mcp-optimizer: --once and --dry-run are exclusive");
            std::process::exit(2);
        }
        let now = match invocation.option("--now") {
            Some(text) => match parse_instant(text) {
                Some(instant) => instant,
                None => {
                    eprintln!("mcp-optimizer: --now needs an ISO-8601 instant");
                    std::process::exit(2);
                }
            },
            None => OffsetDateTime::now_utc(),
        };
        let mut options = CycleOptions::new(root.clone(), state_dir.clone());
        options.now = Some(now);
        options.dry_run = dry_run || collect;
        options.environment = invocation_environment(invocation);
        let directory = mcp_optimizer_directory(&state_dir);
        let details = LockDetails {
            repo: root.to_string_lossy().into_owned(),
            state_dir: owner_state_dir.to_string_lossy().into_owned(),
            harness_version: worker_harness_version(),
            argv: invocation.raw.clone(),
        };
        // A dry run changes nothing, so it takes no lock and creates no
        // directory; only a real cycle needs the cross-version lease.
        let lock = if options.dry_run {
            None
        } else {
            match acquire_lock(&cycle_lock_path(&directory), &details) {
                Ok(guard) => Some(guard),
                Err(owner) => {
                    println!(
                        "mcp-optimizer: a cycle is already running{}",
                        owner
                            .map(|owner| format!(" (pid {})", owner.pid))
                            .unwrap_or_default()
                    );
                    return Ok(());
                }
            }
        };
        let result = run_cycle(options).await?;
        if json {
            println!(
                "{}",
                serde_json::to_string_pretty(&result.report.to_json()).unwrap_or_default()
            );
        } else {
            println!("{}", describe_cycle(&result));
        }
        if let Some(lock) = lock {
            lock.release();
        }
        if result.exit_code != 0 {
            std::process::exit(result.exit_code);
        }
        return Ok(());
    }
    let mut options = WorkerOptions::new(root, state_dir);
    options.owner_state_dir = Some(owner_state_dir);
    let code = run_worker(options).await?;
    if code != 0 {
        anyhow::bail!("mcp-optimizer worker exited with code {code}");
    }
    Ok(())
}

/// The environment one manual cycle reads, from this process.
fn invocation_environment(_invocation: &WorkerInvocation) -> HashMap<String, String> {
    std::env::vars().collect()
}
