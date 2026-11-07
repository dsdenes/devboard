//! The Design System worker: the periodic forge read, the seeded audit cycle,
//! the attributed issue filing through the MCP tool log, the documentation
//! push from one cycle worktree, the release request, and the durable state a
//! dashboard reads.
//!
//! Everything the family owns lives under `<STATE_DIR>/design/<repo-key>/`:
//! the shared legacy state and settings, this harness version's worker state
//! and control channel, and every cycle's request, draft, and activity. The
//! lock, the cycle claim, and the cycle worktrees live inside the checkout at
//! `<REPO_DIR>/.devboard/.tmp/design/`, because one checkout may have only one
//! design cycle whichever dashboard is attached.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use super::api_standards::{run_until_idle, CycleHeartbeat};
use super::WorkerInvocation;
use crate::acp::{
    session_mcp_servers, AcpActivity, AcpConnection, AcpConnectionOptions, AcpEvent, AcpQuestion,
    PermissionPolicy,
};
use crate::workers::startup::{inherited_state_path, versioned_state_files};

/* ------------------------------------------------------------------------ */
/* Constants and paths                                                       */
/* ------------------------------------------------------------------------ */

pub const DESIGN_DIRECTORY: &str = "design";
pub const STATE_VERSION: u64 = 1;
pub const CYCLE_VERSION: u64 = 2;
pub const SYNC_INTERVAL_MS: u64 = 60_000;
pub const HOUR_MS: i64 = 60 * 60_000;
pub const DEFAULT_MAX_PER_HOUR: i64 = 10;
pub const DEFAULT_MAX_PENDING: i64 = 5;
pub const DEFAULT_INTERVAL_MINUTES: i64 = 60;
pub const CADENCE_MIN_MINUTES: i64 = 1;
pub const CADENCE_MAX_MINUTES: i64 = 1440;
pub const LIMIT_MIN: i64 = 1;
pub const LIMIT_MAX: i64 = 100;
pub const CYCLE_ISSUE_LIMIT: i64 = 100;
pub const TITLE_MAX: usize = 200;
pub const DOCUMENTATION_HISTORY_LIMIT: usize = 20;
pub const DEFAULT_SOURCE_DIRECTORY: &str = ".devboard/client";
pub const DEFAULT_DESIGN_DOCUMENT: &str = "DESIGN.md";
pub const DEFAULT_TOKEN_DOCUMENT: &str = "design/tokens.json";
pub const DESIGN_LABEL: &str = "design";
pub const LABEL_COLOR: &str = "1f6feb";
pub const LABEL_DESCRIPTION: &str = "Design system divergence from the documented interface";
pub const DESIGN_CATEGORIES: [&str; 6] = [
    "color",
    "typography",
    "spacing",
    "wording",
    "state",
    "placement",
];

const TICK_MS: u64 = 100;
const DEFAULT_AGENT_COMMAND: &str = "omp acp";
const FIRST_LINE_MAX: usize = 400;
const READ_TIMEOUT_MS: u64 = 30_000;
const CYCLE_TIMEOUT_MS: u64 = 20 * 60_000;
const FETCH_LIMIT_MS: u64 = 10 * 60_000;
const PUSH_ATTEMPTS: usize = 3;
const TEXT_SAMPLE_BYTES: usize = 8192;
const START_TIME_TOLERANCE_MS: i64 = 2_000;

/// `<STATE_DIR>/design`.
pub fn design_root(state_dir: &Path) -> PathBuf {
    resolve(state_dir).join(DESIGN_DIRECTORY)
}

/// `<STATE_DIR>/design/<journal-key>`.
pub fn repo_state_directory(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    design_root(state_dir).join(crate::journal::journal_key(&resolve(repo_dir)))
}

pub fn state_path(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    repo_state_directory(state_dir, repo_dir).join("state.json")
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

pub fn versioned_worker_directory(
    state_dir: &Path,
    repo_dir: &Path,
    version: Option<&str>,
) -> PathBuf {
    repo_state_directory(state_dir, repo_dir)
        .join("workers")
        .join(worker_version_key(version))
}

pub fn versioned_state_path(state_dir: &Path, repo_dir: &Path, version: Option<&str>) -> PathBuf {
    versioned_worker_directory(state_dir, repo_dir, version).join("state.json")
}

pub fn versioned_control_directory(
    state_dir: &Path,
    repo_dir: &Path,
    version: Option<&str>,
) -> PathBuf {
    versioned_worker_directory(state_dir, repo_dir, version).join("control")
}

/// Every versioned worker directory under one repository state.
pub fn worker_state_directories(state_dir: &Path, repo_dir: &Path) -> Vec<PathBuf> {
    let root = repo_state_directory(state_dir, repo_dir).join("workers");
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

pub fn settings_path(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    repo_state_directory(state_dir, repo_dir).join("settings.json")
}

pub fn control_directory(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    repo_state_directory(state_dir, repo_dir).join("control")
}

/// `<REPO_DIR>/.devboard/.tmp/design`.
pub fn work_directory(repo_dir: &Path) -> PathBuf {
    resolve(repo_dir)
        .join(".devboard")
        .join(".tmp")
        .join(DESIGN_DIRECTORY)
}

pub fn lock_path(repo_dir: &Path) -> PathBuf {
    work_directory(repo_dir).join("lock")
}

pub fn versioned_lock_path(repo_dir: &Path, version: Option<&str>) -> PathBuf {
    PathBuf::from(format!(
        "{}.{}",
        lock_path(repo_dir).display(),
        worker_version_key(version)
    ))
}

pub fn cycles_directory(repo_dir: &Path) -> PathBuf {
    work_directory(repo_dir).join("cycles")
}

/// The one checkout-wide lease for the cycle being audited.
pub fn cycle_claim_path(repo_dir: &Path) -> PathBuf {
    work_directory(repo_dir).join("cycle-claim")
}

pub fn cycle_directory(repo_dir: &Path, cycle_id: &str) -> PathBuf {
    cycles_directory(repo_dir).join(cycle_id)
}

pub fn audit_path(directory: &Path) -> PathBuf {
    directory.join("audit.json")
}

pub fn release_request_path(directory: &Path) -> PathBuf {
    directory.join("release-request.json")
}

pub fn request_path(directory: &Path) -> PathBuf {
    directory.join("request.json")
}

pub fn draft_document_path(directory: &Path, document: &str) -> PathBuf {
    directory.join("draft").join(document)
}

pub fn worktrees_root(repo_dir: &Path) -> PathBuf {
    resolve(repo_dir).join(".worktree")
}

pub fn cycle_branch(cycle_id: &str) -> String {
    format!("design/{cycle_id}")
}

/* ------------------------------------------------------------------------ */
/* Path and time arithmetic                                                  */
/* ------------------------------------------------------------------------ */

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
                if !normalized.pop() {
                    normalized.push(component);
                }
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

static ISO_FORMAT: std::sync::LazyLock<
    &'static [time::format_description::BorrowedFormatItem<'static>],
> = std::sync::LazyLock::new(|| {
    time::macros::format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
    )
});

/// One instant as `Date.prototype.toISOString()` writes it.
pub fn iso_from_millis(millis: i64) -> String {
    match time::OffsetDateTime::from_unix_timestamp_nanos(millis as i128 * 1_000_000) {
        Ok(at) => at
            .to_offset(time::UtcOffset::UTC)
            .format(*ISO_FORMAT)
            .unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".to_string()),
        Err(_) => "1970-01-01T00:00:00.000Z".to_string(),
    }
}

/// The epoch milliseconds `Date.parse` reads from an ISO timestamp.
pub fn parse_iso_millis(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    let digits = |start: usize, end: usize| -> Option<i64> {
        let slice = text.get(start..end)?;
        if slice.is_empty() || !slice.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        slice.parse().ok()
    };
    if bytes.get(4) != Some(&b'-') || bytes.get(7) != Some(&b'-') {
        return None;
    }
    let year = digits(0, 4)?;
    let month = digits(5, 7)?;
    let day = digits(8, 10)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (hour, minute, second, millis) = if bytes.get(10) == Some(&b'T') {
        if bytes.get(13) != Some(&b':') || bytes.get(16) != Some(&b':') {
            return None;
        }
        let hour = digits(11, 13)?;
        let minute = digits(14, 16)?;
        let second = digits(17, 19)?;
        let millis = if bytes.get(19) == Some(&b'.') {
            digits(20, 23)?
        } else {
            0
        };
        (hour, minute, second, millis)
    } else {
        (0, 0, 0, 0)
    };
    let month_days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut days: i64 = 0;
    for year_index in 1970..year {
        days += if leap_year(year_index) { 366 } else { 365 };
    }
    for index in 1..month {
        days += month_days[(index - 1) as usize];
    }
    if month > 2 && leap_year(year) {
        days += 1;
    }
    days += day - 1;
    Some(((days * 24 + hour) * 60 + minute) * 60_000 + second * 1_000 + millis)
}

fn leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn first_line(text: &str) -> String {
    text.split('\n')
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("no diagnostic")
        .to_string()
}

fn detail_of(detail: &str) -> String {
    if detail.trim().is_empty() {
        "the cycle failed".to_string()
    } else {
        detail.to_string()
    }
}

/* ------------------------------------------------------------------------ */
/* State                                                                     */
/* ------------------------------------------------------------------------ */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DesignLifecycle {
    Stopped,
    Idle,
    Auditing,
    Releasing,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DesignIssueState {
    Pending,
    Implemented,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DesignSyncState {
    Ok,
    Error,
    Stale,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignWorkerRecord {
    pub pid: u32,
    pub started_at: String,
    pub state_dir: String,
    pub harness_version: Option<String>,
    pub argv: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignLimits {
    pub max_per_hour: Option<i64>,
    pub max_pending: Option<i64>,
}

impl Default for DesignLimits {
    fn default() -> Self {
        Self {
            max_per_hour: Some(DEFAULT_MAX_PER_HOUR),
            max_pending: Some(DEFAULT_MAX_PENDING),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignSettings {
    pub max_per_hour: Option<i64>,
    pub max_pending: Option<i64>,
    pub interval_minutes: i64,
}

impl Default for DesignSettings {
    fn default() -> Self {
        Self {
            max_per_hour: Some(DEFAULT_MAX_PER_HOUR),
            max_pending: Some(DEFAULT_MAX_PENDING),
            interval_minutes: DEFAULT_INTERVAL_MINUTES,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignIssueRow {
    pub number: i64,
    pub title: String,
    pub url: String,
    pub created_at: String,
    pub state: DesignIssueState,
    pub category: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignSync {
    pub state: DesignSyncState,
    pub at: Option<String>,
    pub error: Option<String>,
}

impl DesignSync {
    fn stale() -> Self {
        Self {
            state: DesignSyncState::Stale,
            at: None,
            error: None,
        }
    }
}

/// One forged release as the state records it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignStateRelease {
    pub version: String,
    pub url: String,
    pub at: String,
}

/// One released documentation change, with the exact diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignDocumentationEntry {
    pub at: String,
    pub version: String,
    pub url: String,
    pub summary: String,
    pub files: Vec<String>,
    pub diff: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignState {
    pub version: u64,
    pub repo: String,
    pub root: String,
    pub lifecycle: DesignLifecycle,
    pub enabled: bool,
    pub worker: Option<DesignWorkerRecord>,
    pub limits: DesignLimits,
    pub interval_minutes: i64,
    pub last_cycle_started_at: Option<String>,
    pub issues: Vec<DesignIssueRow>,
    pub sync: DesignSync,
    pub newest_cycle_id: Option<String>,
    pub release: Option<DesignStateRelease>,
    #[serde(default)]
    pub documentation: Vec<DesignDocumentationEntry>,
    pub next_attempt_at: Option<String>,
    pub last_error: Option<String>,
    pub notice: Option<String>,
    #[serde(default)]
    pub draining: bool,
    pub updated_at: String,
}

pub fn empty_state(repo: &str, root: &Path, now_ms: i64) -> DesignState {
    DesignState {
        version: STATE_VERSION,
        repo: repo.to_string(),
        root: root.to_string_lossy().into_owned(),
        lifecycle: DesignLifecycle::Stopped,
        enabled: false,
        worker: None,
        limits: DesignLimits::default(),
        interval_minutes: DEFAULT_INTERVAL_MINUTES,
        last_cycle_started_at: None,
        issues: Vec::new(),
        sync: DesignSync::stale(),
        newest_cycle_id: None,
        release: None,
        documentation: Vec::new(),
        next_attempt_at: None,
        last_error: None,
        notice: None,
        draining: false,
        updated_at: iso_from_millis(now_ms),
    }
}

pub fn is_valid_limit(value: Option<i64>) -> bool {
    value
        .map(|amount| (LIMIT_MIN..=LIMIT_MAX).contains(&amount))
        .unwrap_or(true)
}

pub fn is_valid_cadence(value: i64) -> bool {
    (CADENCE_MIN_MINUTES..=CADENCE_MAX_MINUTES).contains(&value)
}

pub fn parse_state(text: &str) -> Option<DesignState> {
    let value: Value = serde_json::from_str(text).ok()?;
    let object = value.as_object()?;
    if object.get("version").and_then(Value::as_u64) != Some(STATE_VERSION) {
        return None;
    }
    if object
        .get("documentation")
        .map(|documentation| !documentation.is_array())
        .unwrap_or(false)
    {
        return None;
    }
    let state: DesignState = serde_json::from_value(value).ok()?;
    if !is_valid_cadence(state.interval_minutes) {
        return None;
    }
    if !is_valid_limit(state.limits.max_per_hour) || !is_valid_limit(state.limits.max_pending) {
        return None;
    }
    if state.issues.iter().any(|row| row.number <= 0) {
        return None;
    }
    Some(state)
}

pub fn read_state(path: &Path) -> Option<DesignState> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| parse_state(&text))
}

pub fn quarantine(path: &Path) -> Option<PathBuf> {
    let stamp = iso_from_millis(now_millis()).replace([':', '.'], "-");
    for attempt in 0..10 {
        let suffix = if attempt == 0 {
            String::new()
        } else {
            format!("-{attempt}")
        };
        let target = PathBuf::from(format!("{}.invalid-{stamp}{suffix}", path.display()));
        if target.exists() {
            continue;
        }
        return std::fs::rename(path, &target).ok().map(|_| target);
    }
    None
}

/// Reads and moves an unusable file aside, preserved.
pub fn load_state(path: &Path) -> Option<DesignState> {
    if !path.exists() {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    if let Some(state) = parse_state(&text) {
        return Some(state);
    }
    quarantine(path);
    None
}

pub fn write_state(path: &Path, state: &DesignState) -> std::io::Result<()> {
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(state)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?
    );
    crate::state::write_file_atomically_sync(path, &text)
}

pub fn write_atomic(path: &Path, content: &str) -> std::io::Result<()> {
    crate::state::write_file_atomically_sync(path, content)
}

pub fn parse_settings(text: &str) -> Option<DesignSettings> {
    let value: Value = serde_json::from_str(text).ok()?;
    let object = value.as_object()?;
    let limit = |key: &str| -> Option<Option<i64>> {
        match object.get(key) {
            None => None,
            Some(Value::Null) => Some(None),
            Some(Value::Number(number)) => {
                let amount = number.as_i64()?;
                if !(LIMIT_MIN..=LIMIT_MAX).contains(&amount) {
                    return None;
                }
                Some(Some(amount))
            }
            _ => None,
        }
    };
    let max_per_hour = limit("maxPerHour")?;
    let max_pending = limit("maxPending")?;
    let interval_minutes = match object.get("intervalMinutes") {
        None => DEFAULT_INTERVAL_MINUTES,
        Some(Value::Number(number)) => {
            let amount = number.as_i64()?;
            if !is_valid_cadence(amount) {
                return None;
            }
            amount
        }
        _ => return None,
    };
    Some(DesignSettings {
        max_per_hour,
        max_pending,
        interval_minutes,
    })
}

pub fn read_settings(path: &Path) -> Option<DesignSettings> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| parse_settings(&text))
}

pub fn write_settings(path: &Path, settings: &DesignSettings) -> std::io::Result<()> {
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(settings)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?
    );
    crate::state::write_file_atomically_sync(path, &text)
}

/// How many issues a cycle may create under both caps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DesignCapacity {
    pub batch: i64,
    pub window_count: i64,
    pub open_count: i64,
    pub hourly_room: i64,
    pub pending_room: i64,
}

pub fn capacity_for(
    issues: &[DesignIssueRow],
    limits: &DesignLimits,
    now_ms: i64,
) -> DesignCapacity {
    let window_start = now_ms - HOUR_MS;
    let mut window_count = 0i64;
    let mut open_count = 0i64;
    for issue in issues {
        if let Some(created_at) = parse_iso_millis(&issue.created_at) {
            if created_at > window_start {
                window_count += 1;
            }
        }
        if issue.state == DesignIssueState::Pending {
            open_count += 1;
        }
    }
    let hourly_room = match limits.max_per_hour {
        None => i64::MAX,
        Some(limit) => (limit - window_count).max(0),
    };
    let pending_room = match limits.max_pending {
        None => i64::MAX,
        Some(limit) => (limit - open_count).max(0),
    };
    DesignCapacity {
        batch: hourly_room.min(pending_room).min(CYCLE_ISSUE_LIMIT),
        window_count,
        open_count,
        hourly_room,
        pending_room,
    }
}

pub fn record_documentation_entry(
    history: &[DesignDocumentationEntry],
    entry: DesignDocumentationEntry,
) -> Vec<DesignDocumentationEntry> {
    let mut entries = Vec::with_capacity(history.len() + 1);
    entries.push(entry);
    entries.extend(history.iter().cloned());
    entries.truncate(DOCUMENTATION_HISTORY_LIMIT);
    entries
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/* ------------------------------------------------------------------------ */
/* Control channel                                                           */
/* ------------------------------------------------------------------------ */

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DesignCommand {
    Stop,
    Drain,
    Limits {
        max_per_hour: Option<i64>,
        max_pending: Option<i64>,
    },
    Cadence {
        interval_minutes: i64,
    },
    Settings {
        interval_minutes: i64,
        max_per_hour: Option<i64>,
        max_pending: Option<i64>,
    },
}

static COMMAND_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn write_command(directory: &Path, command: &DesignCommand) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(directory)?;
    let sequence = COMMAND_SEQUENCE.fetch_add(1, Ordering::SeqCst) + 1;
    let name = format!("{:014}-{:06}.json", now_millis(), sequence % 1_000_000);
    let path = directory.join(name);
    let value = command_to_json(command);
    let mut text = crate::jsjson::stringify(&value);
    text.push('\n');
    write_atomic(&path, &text)?;
    Ok(path)
}

fn command_to_json(command: &DesignCommand) -> Value {
    match command {
        DesignCommand::Stop => json!({"type": "stop"}),
        DesignCommand::Drain => json!({"type": "drain"}),
        DesignCommand::Limits {
            max_per_hour,
            max_pending,
        } => json!({
            "type": "limits",
            "maxPerHour": max_per_hour,
            "maxPending": max_pending,
        }),
        DesignCommand::Cadence { interval_minutes } => json!({
            "type": "cadence",
            "intervalMinutes": interval_minutes,
        }),
        DesignCommand::Settings {
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

fn limit_field(object: &Map<String, Value>, key: &str) -> Option<Option<i64>> {
    match object.get(key) {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::Number(number)) => {
            let amount = number.as_i64()?;
            if !(LIMIT_MIN..=LIMIT_MAX).contains(&amount) {
                return None;
            }
            Some(Some(amount))
        }
        _ => None,
    }
}

fn cadence_field(object: &Map<String, Value>) -> Option<i64> {
    let amount = object.get("intervalMinutes")?.as_i64()?;
    is_valid_cadence(amount).then_some(amount)
}

pub fn parse_command(text: &str) -> Option<DesignCommand> {
    let value: Value = serde_json::from_str(text).ok()?;
    let object = value.as_object()?;
    match object.get("type").and_then(Value::as_str)? {
        "stop" => Some(DesignCommand::Stop),
        "drain" => Some(DesignCommand::Drain),
        "limits" => Some(DesignCommand::Limits {
            max_per_hour: limit_field(object, "maxPerHour")?,
            max_pending: limit_field(object, "maxPending")?,
        }),
        "cadence" => Some(DesignCommand::Cadence {
            interval_minutes: cadence_field(object)?,
        }),
        "settings" => Some(DesignCommand::Settings {
            interval_minutes: cadence_field(object)?,
            max_per_hour: limit_field(object, "maxPerHour")?,
            max_pending: limit_field(object, "maxPending")?,
        }),
        _ => None,
    }
}

pub fn take_commands(directory: &Path) -> Vec<DesignCommand> {
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
        let path = directory.join(&name);
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

/* ------------------------------------------------------------------------ */
/* Audit input                                                               */
/* ------------------------------------------------------------------------ */

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditFile {
    pub path: String,
    pub lines: usize,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditInput {
    pub sources: Vec<AuditFile>,
    pub documents: Vec<AuditFile>,
    pub source_dir: String,
}

fn line_count(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    let without_final = text.strip_suffix('\n').unwrap_or(text);
    without_final.split('\n').count()
}

fn is_source_file(name: &str) -> bool {
    name == "index.html"
        || name.ends_with(".svelte")
        || name.ends_with(".css")
        || name.ends_with(".ts")
}

fn walk_sources(directory: &Path, found: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    let mut ordered: Vec<std::fs::DirEntry> = entries.filter_map(Result::ok).collect();
    ordered.sort_by_key(|entry| entry.file_name());
    for entry in ordered {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            walk_sources(&entry.path(), found);
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !kind.is_file() || !is_source_file(&name) {
            continue;
        }
        found.push(entry.path());
    }
}

fn read_document(repo_dir: &Path, relative_path: &str) -> Result<AuditFile, String> {
    let absolute = resolve(&repo_dir.join(relative_path));
    let text = std::fs::read_to_string(&absolute)
        .map_err(|_| format!("{relative_path} is not readable"))?;
    Ok(AuditFile {
        path: relative_path.replace('\\', "/"),
        lines: line_count(&text),
        text,
    })
}

/// The interface source set below the configured source directory.
pub fn design_source_paths(repo_dir: &Path, config: &DesignConfig) -> Result<Vec<String>, String> {
    let root = resolve(repo_dir);
    let source_root = resolve(&root.join(&config.source_dir));
    if config.source_dir != DEFAULT_SOURCE_DIRECTORY && !config.source_dir.ends_with("/client") {
        return Err(format!(
            "the audit source {} is not an interface source directory",
            config.source_dir
        ));
    }
    let Ok(source_stat) = std::fs::symlink_metadata(&source_root) else {
        return Err(format!(
            "the canonical harness source checkout has no {} directory (an installed npm prefix is refused)",
            config.source_dir
        ));
    };
    if !source_stat.is_dir() {
        return Err(format!("{} is not a directory", config.source_dir));
    }
    let index_candidates = [
        source_root.join("index.html"),
        source_root.join("..").join("index.html"),
    ];
    let has_index = index_candidates.iter().any(|candidate| {
        std::fs::symlink_metadata(candidate)
            .map(|stat| stat.is_file())
            .unwrap_or(false)
    });
    if !has_index {
        return Err(format!("{} has no index.html entry", config.source_dir));
    }
    let mut absolute_paths = Vec::new();
    walk_sources(&source_root, &mut absolute_paths);
    Ok(absolute_paths
        .into_iter()
        .filter_map(|absolute| {
            absolute
                .strip_prefix(&root)
                .ok()
                .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        })
        .collect())
}

/// Reads every source file plus the two normative documents.
pub fn read_audit_input(repo_dir: &Path, config: &DesignConfig) -> Result<AuditInput, String> {
    let root = resolve(repo_dir);
    let mut sources = Vec::new();
    for path in design_source_paths(&root, config)? {
        let text = std::fs::read_to_string(root.join(&path))
            .map_err(|_| format!("{path} is not readable"))?;
        sources.push(AuditFile {
            path,
            lines: line_count(&text),
            text,
        });
    }
    let documents = vec![
        read_document(&root, &config.design_document)?,
        read_document(&root, &config.token_document)?,
    ];
    Ok(AuditInput {
        sources,
        documents,
        source_dir: config.source_dir.clone(),
    })
}

/* ------------------------------------------------------------------------ */
/* Cycle request, draft validation, and entry point                          */
/* ------------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CycleRequest {
    pub version: u64,
    pub cycle_id: String,
    pub repository: String,
    pub repo_dir: String,
    pub source_dir: String,
    pub documents: Vec<String>,
    pub sources: Vec<CycleSource>,
    pub surface: String,
    pub seed: String,
    pub entry_point: CycleEntryPoint,
    pub categories: Vec<String>,
    pub known_titles: Vec<String>,
    pub issue_room: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CycleSource {
    pub path: String,
    pub lines: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CycleEntryPoint {
    pub path: String,
    pub line: usize,
}

#[derive(Debug, Clone)]
pub struct EntryPoint {
    pub path: String,
    pub line: usize,
    pub surface: String,
    pub seed: String,
}

fn stamp(now_ms: i64) -> String {
    iso_from_millis(now_ms)
        .replace(['-', ':', '.'], "")
        .replace('T', "-")
        .replace('Z', "")
}

static CYCLE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn create_cycle_directory(repo_dir: &Path, now_ms: i64) -> Result<(String, PathBuf), String> {
    std::fs::create_dir_all(cycles_directory(repo_dir))
        .map_err(|error| format!("could not create the cycle root: {error}"))?;
    let base = format!("{}-{:06}", stamp(now_ms), std::process::id());
    for _attempt in 0..100 {
        let sequence = CYCLE_SEQUENCE.fetch_add(1, Ordering::SeqCst) + 1;
        let cycle_id = format!("{base}-{:04}", sequence % 10_000);
        let directory = cycle_directory(repo_dir, &cycle_id);
        match std::fs::create_dir(&directory) {
            Ok(()) => return Ok((cycle_id, directory)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "could not create the cycle directory {}: {error}",
                    directory.display()
                ))
            }
        }
    }
    Err("could not allocate a unique design cycle directory".to_string())
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(value).map_err(|error| error.to_string())?
    );
    crate::state::write_file_atomically_sync(path, &text)
        .map_err(|error| format!("could not write {}: {error}", path.display()))
}

fn sample_bytes(path: &Path) -> Option<Vec<u8>> {
    use std::io::Read as _;
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

fn design_pool(repo_dir: &Path, config: &DesignConfig) -> Result<Vec<String>, String> {
    let root = resolve(repo_dir);
    let mut pooled: Vec<String> = design_source_paths(&root, config)?
        .into_iter()
        .filter(|path| is_text_file(&root.join(path)))
        .collect();
    pooled.sort();
    Ok(pooled)
}

pub fn pick_entry_point(
    repo_dir: &Path,
    surface: &str,
    seed: Option<&str>,
    environment: &HashMap<String, String>,
) -> Result<EntryPoint, String> {
    let config = design_config(environment);
    let root = resolve(repo_dir);
    let files = design_pool(&root, &config)
        .map_err(|error| format!("the design entry-point pool is empty: {error}"))?;
    if files.is_empty() {
        return Err("the design entry-point pool has no eligible file".to_string());
    }
    let seed = match seed {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => {
            use rand::RngCore as _;
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
    let text = std::fs::read_to_string(root.join(&path))
        .map_err(|_| format!("the entry point {path} is not readable"))?;
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
    Ok(EntryPoint {
        path,
        line,
        surface: surface.to_string(),
        seed,
    })
}

pub fn write_cycle(directory: &Path, options: &WriteCycleOptions) -> Result<CycleRequest, String> {
    let source_root = resolve(&options.repo_dir);
    let pick = pick_entry_point(&source_root, "design", None, &options.environment)?;
    let request = CycleRequest {
        version: CYCLE_VERSION,
        cycle_id: options.cycle_id.clone(),
        repository: options.repository.clone(),
        repo_dir: source_root.to_string_lossy().into_owned(),
        source_dir: options.config.source_dir.clone(),
        documents: vec![
            options.config.design_document.clone(),
            options.config.token_document.clone(),
        ],
        sources: options
            .input
            .sources
            .iter()
            .map(|file| CycleSource {
                path: file.path.clone(),
                lines: file.lines,
            })
            .collect(),
        surface: pick.surface.clone(),
        seed: pick.seed.clone(),
        entry_point: CycleEntryPoint {
            path: pick.path.clone(),
            line: pick.line,
        },
        categories: DESIGN_CATEGORIES
            .iter()
            .map(|value| value.to_string())
            .collect(),
        known_titles: {
            let mut titles = options.known_titles.clone();
            titles.sort();
            titles
        },
        issue_room: options.issue_room,
        created_at: iso_from_millis(options.now_ms),
    };
    write_json_atomic(
        &directory.join("input.json"),
        &json!({
            "sources": options.input.sources,
            "documents": options.input.documents,
        }),
    )?;
    let request_value = serde_json::to_value(&request).map_err(|error| error.to_string())?;
    write_json_atomic(&request_path(directory), &request_value)?;
    for document in &options.input.documents {
        let path = draft_document_path(directory, &document.path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        std::fs::write(&path, &document.text)
            .map_err(|error| format!("could not write {}: {error}", path.display()))?;
    }
    Ok(request)
}

#[derive(Debug, Clone)]
pub struct WriteCycleOptions {
    pub cycle_id: String,
    pub repository: String,
    pub repo_dir: PathBuf,
    pub input: AuditInput,
    pub config: DesignConfig,
    pub known_titles: Vec<String>,
    pub issue_room: i64,
    pub now_ms: i64,
    pub environment: HashMap<String, String>,
}

pub fn prompt_for(directory: &Path) -> String {
    format!("/design-system-audit {}", directory.display())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseRequest {
    pub version: u64,
    pub summary: String,
    pub rationale: String,
    pub requested_at: String,
}

pub fn read_release_request(directory: &Path) -> Option<ReleaseRequest> {
    let text = std::fs::read_to_string(release_request_path(directory)).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let object = value.as_object()?;
    let summary = object.get("summary").and_then(Value::as_str)?.trim();
    let rationale = object.get("rationale").and_then(Value::as_str)?.trim();
    if summary.is_empty() || rationale.is_empty() {
        return None;
    }
    Some(ReleaseRequest {
        version: 1,
        summary: summary.to_string(),
        rationale: rationale.to_string(),
        requested_at: object
            .get("requestedAt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    })
}

pub fn read_draft_document(directory: &Path, document: &str) -> Result<String, String> {
    std::fs::read_to_string(draft_document_path(directory, document))
        .map_err(|error| format!("could not read {document} from the draft: {error}"))
}

pub fn draft_changed(directory: &Path, documents: &[AuditFile]) -> bool {
    documents.iter().any(|document| {
        read_draft_document(directory, &document.path)
            .map(|text| text != document.text)
            .unwrap_or(false)
    })
}

const PRINCIPLE_HEADINGS: [&str; 2] = ["## Design principles", "## UX principles"];

pub fn missing_principle_sections(text: &str) -> Vec<String> {
    PRINCIPLE_HEADINGS
        .iter()
        .filter(|heading| !text.contains(**heading))
        .map(|heading| (*heading).to_string())
        .collect()
}

pub fn token_names(text: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut seen = HashSet::new();
    fn walk(value: &Value, names: &mut Vec<String>, seen: &mut HashSet<String>) {
        if let Some(entries) = value.as_array() {
            for entry in entries {
                walk(entry, names, seen);
            }
            return;
        }
        let Some(object) = value.as_object() else {
            return;
        };
        for (key, entry) in object {
            if key.starts_with('$') {
                continue;
            }
            if seen.insert(key.clone()) {
                names.push(key.clone());
            }
            if entry
                .as_object()
                .map(|object| object.contains_key("$value"))
                .unwrap_or(false)
            {
                continue;
            }
            walk(entry, names, seen);
        }
    }
    if let Ok(value) = serde_json::from_str::<Value>(text) {
        walk(&value, &mut names, &mut seen);
    }
    names
}

pub fn token_values(text: &str) -> Vec<(String, String)> {
    let mut values = Vec::new();
    fn walk(value: &Value, values: &mut Vec<(String, String)>) {
        if let Some(entries) = value.as_array() {
            for entry in entries {
                walk(entry, values);
            }
            return;
        }
        let Some(object) = value.as_object() else {
            return;
        };
        for (key, entry) in object {
            if key.starts_with('$') {
                continue;
            }
            if let Some(leaf) = entry.as_object().and_then(|object| object.get("$value")) {
                values.push((
                    key.clone(),
                    serde_json::to_string(leaf).unwrap_or_else(|_| "null".to_string()),
                ));
                continue;
            }
            walk(entry, values);
        }
    }
    if let Ok(value) = serde_json::from_str::<Value>(text) {
        walk(&value, &mut values);
    }
    values
}

pub fn valid_token_document(text: &str) -> bool {
    serde_json::from_str::<Value>(text)
        .map(|value| value.is_object())
        .unwrap_or(false)
}

pub fn tokens_named_in_prose(changed_tokens: &[String], prose: &str) -> Vec<String> {
    changed_tokens
        .iter()
        .filter(|name| !prose.contains(name.as_str()))
        .cloned()
        .collect()
}

/* ------------------------------------------------------------------------ */
/* Locks                                                                     */
/* ------------------------------------------------------------------------ */

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockOwner {
    pub pid: u32,
    pub started_at: String,
    pub repo: String,
    pub state_dir: String,
    pub harness_version: Option<String>,
    pub argv: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct LockDetails {
    pub repo: String,
    pub state_dir: String,
    pub harness_version: Option<String>,
    pub argv: Vec<String>,
}

fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if result == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn process_started_at(pid: u32) -> Option<i64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let close = stat.rfind(')')?;
    let start_ticks: f64 = stat.get(close + 2..)?.split(' ').nth(19)?.parse().ok()?;
    let uptime: f64 = std::fs::read_to_string("/proc/uptime")
        .ok()?
        .split(' ')
        .next()?
        .parse()
        .ok()?;
    Some((now_millis() as f64 - uptime * 1000.0 + start_ticks * 10.0) as i64)
}

fn own_started_at() -> String {
    process_started_at(std::process::id())
        .map(iso_from_millis)
        .unwrap_or_else(|| iso_from_millis(now_millis()))
}

fn owner_alive(owner: &LockOwner) -> bool {
    if !pid_alive(owner.pid) {
        return false;
    }
    let Some(recorded) = parse_iso_millis(&owner.started_at) else {
        return false;
    };
    match process_started_at(owner.pid) {
        Some(actual) => (actual - recorded).abs() <= START_TIME_TOLERANCE_MS,
        None => cfg!(not(target_os = "linux")),
    }
}

fn parse_lock(text: &str) -> Option<LockOwner> {
    let value: Value = serde_json::from_str(text).ok()?;
    let object = value.as_object()?;
    let pid = object.get("pid")?.as_u64()?;
    if pid == 0 || pid > u32::MAX as u64 {
        return None;
    }
    Some(LockOwner {
        pid: pid as u32,
        started_at: object.get("startedAt")?.as_str()?.to_string(),
        repo: object
            .get("repo")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        state_dir: object
            .get("stateDir")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        harness_version: object
            .get("harnessVersion")
            .and_then(Value::as_str)
            .map(str::to_string),
        argv: object
            .get("argv")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
    })
}

fn read_lock(path: &Path) -> Option<LockOwner> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| parse_lock(&text))
}

pub fn live_lock_owner(path: &Path) -> Option<LockOwner> {
    read_lock(path).filter(owner_alive)
}

pub fn live_lock_owners(path: &Path) -> Vec<LockOwner> {
    let mut owners = Vec::new();
    if let Some(legacy) = live_lock_owner(path) {
        owners.push(legacy);
    }
    let (Some(parent), Some(base)) = (
        path.parent(),
        path.file_name().and_then(|name| name.to_str()),
    ) else {
        return owners;
    };
    let prefix = format!("{base}.");
    let mut names: Vec<String> = std::fs::read_dir(parent)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    for name in names {
        if !name.starts_with(&prefix) || name.contains(".reclaim-") || name.contains(".new-") {
            continue;
        }
        if let Some(owner) = live_lock_owner(&parent.join(name)) {
            owners.push(owner);
        }
    }
    owners
}

#[derive(Debug)]
pub struct LockGuard {
    path: PathBuf,
    token: String,
}

impl LockGuard {
    pub fn release(self) {
        release_lock(&self.path, &self.token);
    }
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        release_lock(&self.path, &self.token);
    }
}

fn lock_token(path: &Path) -> Option<String> {
    let value: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    value.get("token")?.as_str().map(str::to_string)
}

fn release_lock(path: &Path, token: &str) {
    if lock_token(path).as_deref() != Some(token) {
        return;
    }
    let _ = std::fs::remove_file(path);
}

#[derive(Debug)]
pub enum LockAcquisition {
    Acquired(LockGuard),
    Taken { owner: Option<LockOwner> },
}

/// Takes the lock, or reports the live owner. A stale lock is reclaimed once.
pub fn acquire_lock(path: &Path, details: &LockDetails) -> LockAcquisition {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let token = uuid::Uuid::new_v4().to_string();
    for _attempt in 0..2 {
        let staged = PathBuf::from(format!(
            "{}.new-{}-{}",
            path.display(),
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let mut record = Map::new();
        record.insert("pid".into(), Value::from(std::process::id()));
        record.insert("startedAt".into(), Value::from(own_started_at()));
        record.insert("repo".into(), Value::from(details.repo.clone()));
        record.insert("stateDir".into(), Value::from(details.state_dir.clone()));
        record.insert(
            "harnessVersion".into(),
            details
                .harness_version
                .clone()
                .map(Value::from)
                .unwrap_or(Value::Null),
        );
        record.insert(
            "argv".into(),
            Value::Array(details.argv.iter().cloned().map(Value::from).collect()),
        );
        record.insert("token".into(), Value::from(token.clone()));
        let mut text = crate::jsjson::stringify(&Value::Object(record));
        text.push('\n');
        if std::fs::write(&staged, text).is_err() {
            let _ = std::fs::remove_file(&staged);
            return LockAcquisition::Taken { owner: None };
        }
        let linked = std::fs::hard_link(&staged, path);
        let _ = std::fs::remove_file(&staged);
        match linked {
            Ok(()) => {
                return LockAcquisition::Acquired(LockGuard {
                    path: path.to_path_buf(),
                    token,
                })
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if let Some(owner) = read_lock(path) {
                    if owner_alive(&owner) {
                        return LockAcquisition::Taken { owner: Some(owner) };
                    }
                }
                let _ = std::fs::remove_file(path);
            }
            Err(_) => return LockAcquisition::Taken { owner: None },
        }
    }
    LockAcquisition::Taken { owner: None }
}

impl LockAcquisition {
    pub fn acquired(self) -> Option<LockGuard> {
        match self {
            LockAcquisition::Acquired(guard) => Some(guard),
            LockAcquisition::Taken { .. } => None,
        }
    }

    pub fn owner(self) -> Option<LockOwner> {
        match self {
            LockAcquisition::Acquired(_) => None,
            LockAcquisition::Taken { owner } => owner,
        }
    }
}

/* ------------------------------------------------------------------------ */
/* Configuration                                                             */
/* ------------------------------------------------------------------------ */

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesignConfig {
    pub source_dir: String,
    pub design_document: String,
    pub token_document: String,
}

impl Default for DesignConfig {
    fn default() -> Self {
        Self {
            source_dir: DEFAULT_SOURCE_DIRECTORY.to_string(),
            design_document: DEFAULT_DESIGN_DOCUMENT.to_string(),
            token_document: DEFAULT_TOKEN_DOCUMENT.to_string(),
        }
    }
}

fn configured(environment: &HashMap<String, String>, key: &str, fallback: &str) -> String {
    match environment.get(key).map(|value| value.trim()) {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => fallback.to_string(),
    }
}

pub fn design_config(environment: &HashMap<String, String>) -> DesignConfig {
    DesignConfig {
        source_dir: configured(environment, "DESIGN_SOURCE_DIR", DEFAULT_SOURCE_DIRECTORY),
        design_document: configured(environment, "DESIGN_DOCUMENT", DEFAULT_DESIGN_DOCUMENT),
        token_document: configured(environment, "DESIGN_TOKEN_DOCUMENT", DEFAULT_TOKEN_DOCUMENT),
    }
}

/* ------------------------------------------------------------------------ */
/* Forge                                                                     */
/* ------------------------------------------------------------------------ */

pub type ForgeFuture<T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForgeIssueState {
    Open,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesignForgeIssue {
    pub number: i64,
    pub title: String,
    pub url: String,
    pub state: ForgeIssueState,
    pub created_at: String,
    pub closed_at: Option<String>,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForgeRelease {
    pub tag: String,
    pub published_at: String,
}

/// The forge facts one design worker reads. It is a trait so a fixture can
/// inject the exact rows and failures a cycle must handle.
pub trait DesignForge: Send + Sync {
    fn list_issues(&self) -> ForgeFuture<Vec<DesignForgeIssue>>;
    fn list_open_issue_titles(&self) -> ForgeFuture<Vec<String>>;
    fn list_releases(&self) -> ForgeFuture<Vec<ForgeRelease>>;
    fn shipped_version(
        &self,
        issue: DesignForgeIssue,
        releases: Vec<ForgeRelease>,
    ) -> ForgeFuture<Option<String>> {
        let _ = (issue, releases);
        Box::pin(async { Ok(None) })
    }
}

fn rate_limited(text: &str) -> bool {
    let message = text.to_ascii_lowercase();
    [
        "rate limit exceeded",
        "secondary rate limit",
        "abuse detection",
        "too many requests",
        "http 429",
    ]
    .iter()
    .any(|pattern| message.contains(pattern))
}

fn parse_gh_array(text: &str) -> Result<Vec<Value>, String> {
    let value: Value = serde_json::from_str(text)
        .map_err(|_| "gh issue list did not print a JSON array".to_string())?;
    match value {
        Value::Array(entries) => Ok(entries),
        _ => Err("gh issue list did not print a JSON array".to_string()),
    }
}

fn gh_runner(
    environment: HashMap<String, String>,
    timeout_ms: u64,
) -> crate::forge::GitHubCommandRunner {
    Arc::new(move |argv, env| {
        let environment = if env.is_empty() {
            environment.clone()
        } else {
            env
        };
        Box::pin(async move {
            let mut command = tokio::process::Command::new("gh");
            command
                .args(&argv)
                .envs(&environment)
                .env("GH_PROMPT_DISABLED", "1")
                .env("GH_NO_UPDATE_NOTIFIER", "1")
                .env("GIT_TERMINAL_PROMPT", "0")
                .env("NO_COLOR", "1")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true);
            let child = match command.spawn() {
                Ok(child) => child,
                Err(error) => {
                    return crate::forge::GitHubCommandOutcome {
                        code: 1,
                        stdout: String::new(),
                        stderr: error.to_string(),
                    }
                }
            };
            match tokio::time::timeout(
                Duration::from_millis(timeout_ms.max(1)),
                child.wait_with_output(),
            )
            .await
            {
                Ok(Ok(output)) => crate::forge::GitHubCommandOutcome {
                    code: output.status.code().unwrap_or(1),
                    stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                    stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
                },
                Ok(Err(error)) => crate::forge::GitHubCommandOutcome {
                    code: 1,
                    stdout: String::new(),
                    stderr: error.to_string(),
                },
                Err(_) => crate::forge::GitHubCommandOutcome {
                    code: 1,
                    stdout: String::new(),
                    stderr: "gh did not finish before its deadline".to_string(),
                },
            }
        })
    })
}

struct LiveDesignForge {
    repository: String,
    repo_dir: PathBuf,
    environment: HashMap<String, String>,
    forge: crate::forge::Forge,
    timeout_ms: u64,
}

fn gitea_target_for(
    repository: &str,
    repo_dir: &Path,
    environment: &HashMap<String, String>,
) -> Result<crate::forge::GiteaTarget, String> {
    let remote = crate::forge::origin_forge_with(repo_dir, environment);
    crate::forge::gitea_target(remote.as_ref(), Some(repository), None, None, environment)
        .map_err(|error| error.to_string())
}

async fn gitea_design_issues(
    repository: String,
    repo_dir: PathBuf,
    environment: HashMap<String, String>,
    timeout_ms: u64,
    state: crate::forge::IssueQueryState,
) -> Result<Vec<DesignForgeIssue>, String> {
    let target = gitea_target_for(&repository, &repo_dir, &environment)?;
    let transport = crate::forge::default_transport(timeout_ms);
    let options = crate::forge::GiteaCallOptions {
        flow_id: None,
        timeout_ms: Some(timeout_ms),
    };
    // The open listing answers the duplicate-title check and must carry every
    // open issue. Every other state is asked of the forge by the design label,
    // so the read never pages the whole board to discard other families' issues.
    let issues = match state {
        crate::forge::IssueQueryState::Open => {
            crate::forge::gitea_list_issues(&target, state, &transport, &options).await
        }
        _ => {
            crate::forge::gitea_list_labelled_issues(
                &target,
                state,
                DESIGN_LABEL,
                &transport,
                &options,
            )
            .await
        }
    }
    .map_err(|error| error.to_string())?;
    Ok(issues
        .into_iter()
        .map(|issue| DesignForgeIssue {
            number: issue.number,
            title: issue.title,
            url: issue.url,
            state: if issue.state == crate::forge::IssueState::Closed {
                ForgeIssueState::Closed
            } else {
                ForgeIssueState::Open
            },
            created_at: issue.created_at,
            closed_at: issue.closed_at,
            body: issue.body,
        })
        .collect())
}

async fn github_list_issues(
    repository: String,
    environment: HashMap<String, String>,
    timeout_ms: u64,
) -> Result<Vec<DesignForgeIssue>, String> {
    let run = gh_runner(environment.clone(), timeout_ms);
    let outcome = run(
        vec![
            "issue".to_string(),
            "list".to_string(),
            "--repo".to_string(),
            repository,
            "--label".to_string(),
            DESIGN_LABEL.to_string(),
            "--state".to_string(),
            "all".to_string(),
            "--limit".to_string(),
            "1000".to_string(),
            "--json".to_string(),
            "number,title,url,state,createdAt,closedAt,body".to_string(),
        ],
        environment,
    )
    .await;
    if outcome.code != 0 {
        return Err(first_line(&outcome.stderr));
    }
    let entries = parse_gh_array(&outcome.stdout)?;
    let mut issues = Vec::new();
    let mut seen = HashSet::new();
    for entry in entries {
        let Some(record) = entry.as_object() else {
            continue;
        };
        let Some(number) = record.get("number").and_then(Value::as_i64) else {
            continue;
        };
        let (Some(title), Some(url), Some(created_at), Some(body), Some(state)) = (
            record.get("title").and_then(Value::as_str),
            record.get("url").and_then(Value::as_str),
            record.get("createdAt").and_then(Value::as_str),
            record.get("body").and_then(Value::as_str),
            record.get("state").and_then(Value::as_str),
        ) else {
            continue;
        };
        if !seen.insert(number) {
            continue;
        }
        let closed_at = record
            .get("closedAt")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        issues.push(DesignForgeIssue {
            number,
            title: title.to_string(),
            url: url.to_string(),
            state: if state.eq_ignore_ascii_case("closed") {
                ForgeIssueState::Closed
            } else {
                ForgeIssueState::Open
            },
            created_at: created_at.to_string(),
            closed_at,
            body: body.to_string(),
        });
    }
    Ok(issues)
}

async fn github_open_titles(
    repository: String,
    environment: HashMap<String, String>,
    timeout_ms: u64,
) -> Result<Vec<String>, String> {
    let run = gh_runner(environment.clone(), timeout_ms);
    let outcome = run(
        vec![
            "issue".to_string(),
            "list".to_string(),
            "--repo".to_string(),
            repository,
            "--state".to_string(),
            "open".to_string(),
            "--limit".to_string(),
            "1000".to_string(),
            "--json".to_string(),
            "title".to_string(),
        ],
        environment,
    )
    .await;
    if outcome.code != 0 {
        return Err(first_line(&outcome.stderr));
    }
    let entries = parse_gh_array(&outcome.stdout)?;
    Ok(entries
        .iter()
        .filter_map(|entry| entry.get("title").and_then(Value::as_str))
        .map(str::to_string)
        .collect())
}

async fn github_releases(
    repository: String,
    repo_dir: PathBuf,
    environment: HashMap<String, String>,
    timeout_ms: u64,
) -> Result<Vec<ForgeRelease>, String> {
    let client = crate::forge::RepositoryGitHub::new(crate::forge::RepositoryGitHubOptions {
        repository,
        repo_dir,
        run: gh_runner(environment.clone(), timeout_ms),
        environment,
    });
    let releases = client.list_releases().await?;
    Ok(releases
        .into_iter()
        .map(|release| ForgeRelease {
            tag: release.tag,
            published_at: release.published_at,
        })
        .collect())
}

async fn gitea_releases(
    repository: String,
    repo_dir: PathBuf,
    environment: HashMap<String, String>,
    timeout_ms: u64,
) -> Result<Vec<ForgeRelease>, String> {
    let target = gitea_target_for(&repository, &repo_dir, &environment)?;
    let transport = crate::forge::default_transport(timeout_ms);
    let options = crate::forge::GiteaCallOptions {
        flow_id: None,
        timeout_ms: Some(timeout_ms),
    };
    Ok(
        crate::forge::gitea_list_releases(&target, &transport, &options)
            .await
            .map_err(|error| error.to_string())?
            .into_iter()
            .map(|release| ForgeRelease {
                tag: release.tag,
                published_at: release.published_at,
            })
            .collect(),
    )
}

impl DesignForge for LiveDesignForge {
    fn list_issues(&self) -> ForgeFuture<Vec<DesignForgeIssue>> {
        let repository = self.repository.clone();
        let repo_dir = self.repo_dir.clone();
        let environment = self.environment.clone();
        let timeout_ms = self.timeout_ms;
        if self.forge == crate::forge::Forge::Gitea {
            return Box::pin(async move {
                gitea_design_issues(
                    repository,
                    repo_dir,
                    environment,
                    timeout_ms,
                    crate::forge::IssueQueryState::All,
                )
                .await
            });
        }
        Box::pin(async move { github_list_issues(repository, environment, timeout_ms).await })
    }

    fn list_open_issue_titles(&self) -> ForgeFuture<Vec<String>> {
        let repository = self.repository.clone();
        let repo_dir = self.repo_dir.clone();
        let environment = self.environment.clone();
        let timeout_ms = self.timeout_ms;
        if self.forge == crate::forge::Forge::Gitea {
            return Box::pin(async move {
                Ok(gitea_design_issues(
                    repository,
                    repo_dir,
                    environment,
                    timeout_ms,
                    crate::forge::IssueQueryState::Open,
                )
                .await?
                .into_iter()
                .map(|issue| issue.title)
                .collect())
            });
        }
        Box::pin(async move { github_open_titles(repository, environment, timeout_ms).await })
    }

    fn list_releases(&self) -> ForgeFuture<Vec<ForgeRelease>> {
        let repository = self.repository.clone();
        let repo_dir = self.repo_dir.clone();
        let environment = self.environment.clone();
        let timeout_ms = self.timeout_ms;
        if self.forge == crate::forge::Forge::Gitea {
            return Box::pin(async move {
                gitea_releases(repository, repo_dir, environment, timeout_ms).await
            });
        }
        Box::pin(
            async move { github_releases(repository, repo_dir, environment, timeout_ms).await },
        )
    }

    fn shipped_version(
        &self,
        issue: DesignForgeIssue,
        releases: Vec<ForgeRelease>,
    ) -> ForgeFuture<Option<String>> {
        let repository = self.repository.clone();
        let repo_dir = self.repo_dir.clone();
        let environment = self.environment.clone();
        let timeout_ms = self.timeout_ms;
        let forge = self.forge;
        Box::pin(async move {
            if issue.state != ForgeIssueState::Closed {
                return Ok(None);
            }
            let commits = if forge == crate::forge::Forge::Gitea {
                let target = gitea_target_for(&repository, &repo_dir, &environment)?;
                let transport = crate::forge::default_transport(timeout_ms);
                let options = crate::forge::GiteaCallOptions {
                    flow_id: None,
                    timeout_ms: Some(timeout_ms),
                };
                crate::forge::gitea_closing_commits(&target, issue.number, &transport, &options)
                    .await
                    .map_err(|error| error.to_string())?
            } else {
                let client =
                    crate::forge::RepositoryGitHub::new(crate::forge::RepositoryGitHubOptions {
                        repository,
                        repo_dir: repo_dir.clone(),
                        run: gh_runner(environment, timeout_ms),
                        environment: HashMap::new(),
                    });
                client
                    .closing_commits(issue.number)
                    .await
                    .map_err(|error| error.to_string())?
            };
            for short in commits {
                let outcome = crate::forge::git(
                    &repo_dir,
                    &["rev-parse", "--verify", &format!("{short}^{{commit}}")],
                );
                if outcome.code != 0 {
                    continue;
                }
                let Some(commit) = outcome.stdout.split_whitespace().next() else {
                    continue;
                };
                let tags: Vec<String> =
                    crate::forge::git(&repo_dir, &["tag", "--contains", commit])
                        .stdout
                        .lines()
                        .map(str::trim)
                        .filter(|line| !line.is_empty())
                        .map(str::to_string)
                        .collect();
                let mut ordered = releases.clone();
                ordered.sort_by(|left, right| left.published_at.cmp(&right.published_at));
                if let Some(release) = ordered
                    .into_iter()
                    .find(|release| tags.iter().any(|tag| tag == &release.tag))
                {
                    return Ok(Some(release.tag.trim_start_matches('v').to_string()));
                }
            }
            Ok(None)
        })
    }
}

pub fn create_design_forge(
    repository: &str,
    repo_dir: &Path,
    environment: &HashMap<String, String>,
    timeout_ms: u64,
) -> Result<Arc<dyn DesignForge>, String> {
    let remote = crate::forge::origin_forge_with(repo_dir, environment);
    let forge = remote
        .as_ref()
        .map(|remote| remote.forge)
        .unwrap_or(crate::forge::Forge::GitHub);
    if forge == crate::forge::Forge::GitLab {
        return Err(
            "the design agent supports a GitHub or Gitea origin, not a GitLab one".to_string(),
        );
    }
    if forge == crate::forge::Forge::Gitea {
        let base = crate::forge::gitea_base_url(remote.as_ref(), environment)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                "the design agent needs DEVBOARD_GITEA_URL for a Gitea origin".to_string()
            })?;
        let _ = base;
    }
    Ok(Arc::new(LiveDesignForge {
        repository: repository.to_string(),
        repo_dir: repo_dir.to_path_buf(),
        environment: environment.clone(),
        forge,
        timeout_ms,
    }))
}

/* ------------------------------------------------------------------------ */
/* Documentation release                                                     */
/* ------------------------------------------------------------------------ */

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseDocument {
    pub path: String,
    pub text: String,
}

pub type ActivitySink = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Clone)]
pub struct ReleaseInput {
    pub repo_dir: PathBuf,
    pub harness_dir: PathBuf,
    pub cycle_id: String,
    pub summary: String,
    pub config: DesignConfig,
    pub documents: Vec<ReleaseDocument>,
    pub environment: HashMap<String, String>,
    pub activity: ActivitySink,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseOk {
    pub version: String,
    pub url: String,
    pub sha: String,
    pub branch: String,
    pub files: Vec<String>,
    pub diff: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseFailure {
    pub detail: String,
    pub step: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReleaseResult {
    Ok(ReleaseOk),
    Failed(ReleaseFailure),
}

pub type ReleaseFuture = Pin<Box<dyn Future<Output = ReleaseResult> + Send>>;
pub type ReleaseFn = Arc<dyn Fn(ReleaseInput) -> ReleaseFuture + Send + Sync>;

fn bounded_environment(environment: &HashMap<String, String>) -> HashMap<String, String> {
    let mut merged = environment.clone();
    merged.insert("GIT_TERMINAL_PROMPT".to_string(), "0".to_string());
    merged.insert("NO_COLOR".to_string(), "1".to_string());
    merged
}

async fn git(
    directory: &Path,
    args: &[&str],
    environment: &HashMap<String, String>,
) -> crate::git::GitResult {
    crate::git::run_git(
        directory,
        args,
        &bounded_environment(environment),
        FETCH_LIMIT_MS,
    )
    .await
}

fn must(outcome: crate::git::GitResult, description: &str) -> Result<String, String> {
    if outcome.code != 0 {
        let detail = if outcome.stderr.trim().is_empty() {
            first_line(&outcome.stdout)
        } else {
            first_line(&outcome.stderr)
        };
        return Err(format!("{description}: {detail}"));
    }
    Ok(outcome.stdout.trim().to_string())
}

fn commit_url(
    repo_dir: &Path,
    environment: &HashMap<String, String>,
    project: &str,
    sha: &str,
) -> String {
    let remote = crate::forge::origin_forge_with(repo_dir, environment);
    if let Some(remote) = &remote {
        if remote.forge == crate::forge::Forge::Gitea {
            if let Some(base) = crate::forge::gitea_base_url(Some(remote), environment) {
                return format!("{}/{project}/commit/{sha}", base.trim_end_matches('/'));
            }
        }
        if remote.forge == crate::forge::Forge::GitHub {
            return format!("https://github.com/{project}/commit/{sha}");
        }
    }
    format!("{project}/commit/{sha}")
}

fn default_checks(worktree: &Path, config: &DesignConfig) -> Result<(), String> {
    let design_path = worktree.join(&config.design_document);
    let prose = std::fs::read_to_string(&design_path)
        .map_err(|_| format!("{} is missing", config.design_document))?;
    let missing = missing_principle_sections(&prose);
    if !missing.is_empty() {
        return Err(format!("the documentation lacks {}", missing.join(" and ")));
    }
    let token_path = worktree.join(&config.token_document);
    let tokens = std::fs::read_to_string(&token_path)
        .map_err(|_| format!("{} is missing", config.token_document))?;
    if !valid_token_document(&tokens) {
        return Err(format!("{} is not a JSON object", config.token_document));
    }
    Ok(())
}

fn derive_version(repo_dir: &Path, sha: &str) -> String {
    const BASELINE: &str = "1.0.0";
    let described = crate::forge::git(repo_dir, &["describe", "--tags", "--abbrev=0", sha]);
    let previous = if described.code == 0 {
        let tag = described.stdout.trim();
        let version = tag.trim_start_matches('v');
        if version.split('.').count() == 3
            && version
                .split('.')
                .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        {
            Some(version.to_string())
        } else {
            None
        }
    } else {
        None
    };
    let range = previous
        .as_ref()
        .map(|version| format!("v{version}..{sha}"))
        .unwrap_or_else(|| sha.to_string());
    let log = crate::forge::git(repo_dir, &["log", "--format=%s", &range]);
    let subjects: Vec<&str> = log
        .stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let level = if subjects.iter().any(|subject| {
        subject
            .split(':')
            .next()
            .map(|header| header.contains('!'))
            .unwrap_or(false)
            || subject.contains("BREAKING CHANGE")
    }) {
        Some(0)
    } else if subjects.iter().any(|subject| subject.starts_with("feat")) {
        Some(1)
    } else if subjects.is_empty() {
        None
    } else {
        Some(2)
    };
    let Some(previous) = previous else {
        return BASELINE.to_string();
    };
    let mut parts: Vec<u64> = previous
        .split('.')
        .map(|part| part.parse().unwrap_or(0))
        .collect();
    if parts.len() != 3 {
        return BASELINE.to_string();
    }
    if compare_versions(&previous, BASELINE) == Some(std::cmp::Ordering::Less) {
        return BASELINE.to_string();
    }
    match level {
        None => previous,
        Some(0) => {
            parts[0] += 1;
            parts[1] = 0;
            parts[2] = 0;
            format!("{}.{}.{}", parts[0], parts[1], parts[2])
        }
        Some(1) => {
            parts[1] += 1;
            parts[2] = 0;
            format!("{}.{}.{}", parts[0], parts[1], parts[2])
        }
        _ => {
            parts[2] += 1;
            format!("{}.{}.{}", parts[0], parts[1], parts[2])
        }
    }
}

fn compare_versions(left: &str, right: &str) -> Option<std::cmp::Ordering> {
    let parse = |version: &str| -> Option<[u64; 3]> {
        let parts: Vec<&str> = version.split('.').collect();
        if parts.len() != 3 {
            return None;
        }
        let mut parsed = [0u64; 3];
        for (index, part) in parts.iter().enumerate() {
            if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            parsed[index] = part.parse().ok()?;
        }
        Some(parsed)
    };
    let left = parse(left)?;
    let right = parse(right)?;
    Some(left.cmp(&right))
}

struct Worktree {
    directory: PathBuf,
    branch: String,
}

async fn remove_worktree(
    repo_dir: &Path,
    worktree: &Worktree,
    environment: &HashMap<String, String>,
) {
    if worktree.directory.exists() {
        let _ = git(
            worktree.directory.as_path(),
            &[
                "worktree",
                "remove",
                "--force",
                &worktree.directory.to_string_lossy(),
            ],
            environment,
        )
        .await;
        if worktree.directory.exists() {
            let _ = std::fs::remove_dir_all(&worktree.directory);
        }
    }
    let _ = git(repo_dir, &["worktree", "prune"], environment).await;
    let _ = git(repo_dir, &["branch", "-D", &worktree.branch], environment).await;
}

async fn ensure_worktree(
    repo_dir: &Path,
    cycle_id: &str,
    environment: &HashMap<String, String>,
) -> Result<Worktree, String> {
    std::fs::create_dir_all(worktrees_root(repo_dir))
        .map_err(|error| format!("could not create the worktree root: {error}"))?;
    let directory = worktrees_root(repo_dir).join(format!("design-{cycle_id}"));
    let branch = cycle_branch(cycle_id);
    if directory.exists() {
        return Err(format!(
            "the cycle worktree already exists: {}",
            directory.display()
        ));
    }
    let remote = git(
        repo_dir,
        &["rev-parse", "--verify", "--quiet", "origin/main"],
        environment,
    )
    .await;
    let base = if remote.code == 0 {
        "origin/main"
    } else {
        "main"
    };
    let directory_text = directory.to_string_lossy().into_owned();
    let added = git(
        repo_dir,
        &["worktree", "add", "-b", &branch, &directory_text, base],
        environment,
    )
    .await;
    if added.code != 0 {
        if directory.exists() {
            let _ = std::fs::remove_dir_all(&directory);
        }
        let _ = git(repo_dir, &["worktree", "prune"], environment).await;
        let _ = git(repo_dir, &["branch", "-D", &branch], environment).await;
        let detail = if added.stderr.trim().is_empty() {
            first_line(&added.stdout)
        } else {
            first_line(&added.stderr)
        };
        return Err(format!(
            "could not create the cycle worktree from {base}: {detail}"
        ));
    }
    Ok(Worktree { directory, branch })
}

async fn resolve_conflicts(
    worktree: &Path,
    paths: &[String],
    environment: &HashMap<String, String>,
    activity: &ActivitySink,
    retry: bool,
) -> Result<(), String> {
    let conflicts = git(
        worktree,
        &["diff", "--name-only", "--diff-filter=U"],
        environment,
    )
    .await;
    let conflicted: Vec<String> = conflicts
        .stdout
        .lines()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(str::to_string)
        .collect();
    for path in conflicted {
        if !paths.contains(&path) {
            let label = if retry { "the retry" } else { "the cycle" };
            return Err(format!(
                "a conflict outside the two documents blocks {label}: {path}"
            ));
        }
        must(
            git(worktree, &["checkout", "--ours", "--", &path], environment).await,
            &format!("could not resolve {path}"),
        )?;
        must(
            git(worktree, &["add", "--", &path], environment).await,
            &format!("could not stage {path}"),
        )?;
        if retry {
            activity(&format!(
                "resolved the retry conflict in {path} with the cycle's accepted standard"
            ));
        } else {
            activity(&format!(
                "resolved the conflict in {path} with the cycle's accepted standard"
            ));
        }
    }
    Ok(())
}

/// One documentation release: one worktree, one commit limited to the two
/// documents, integration of main, a non-force push, and cleanup.
pub async fn release_documents(input: ReleaseInput) -> ReleaseResult {
    let environment = input.environment.clone();
    let paths: Vec<String> = input
        .documents
        .iter()
        .map(|document| document.path.clone())
        .collect();
    let project = crate::forge::origin_forge_with(&input.repo_dir, &environment)
        .map(|remote| remote.project)
        .unwrap_or_default();
    let mut pushed = false;
    let mut worktree: Option<Worktree> = None;
    let outcome = async {
        let created = ensure_worktree(&input.repo_dir, &input.cycle_id, &environment).await?;
        worktree = Some(created);
        let directory = worktree.as_ref().expect("the worktree").directory.clone();
        (input.activity)(&format!("documentation: {}", input.summary));
        for document in &input.documents {
            let target = directory.join(&document.path);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
            }
            std::fs::write(&target, &document.text)
                .map_err(|error| format!("could not apply {}: {error}", document.path))?;
            let written = std::fs::read_to_string(&target)
                .map_err(|error| format!("could not read back {}: {error}", document.path))?;
            if written != document.text {
                return Err(format!(
                    "could not apply {} to the cycle worktree",
                    document.path
                ));
            }
        }
        let status = must(
            git(
                &directory,
                &["status", "--porcelain", "--untracked-files=no"],
                &environment,
            )
            .await,
            "could not read the cycle worktree status",
        )?;
        let changed: Vec<String> = status
            .lines()
            .map(|line| {
                line.split_whitespace()
                    .skip(1)
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .filter(|path| !path.is_empty())
            .collect();
        if changed.is_empty() {
            return Err("the admissible decision produced no document change".to_string());
        }
        if let Some(outside) = changed.iter().find(|path| !paths.contains(path)) {
            return Err(format!(
                "the cycle changed a file outside the two documents: {outside}"
            ));
        }
        let mut add_arguments: Vec<&str> = vec!["add", "--"];
        add_arguments.extend(paths.iter().map(String::as_str));
        must(
            git(&directory, &add_arguments, &environment).await,
            "could not stage the documents",
        )?;
        let message: String = format!("docs(design): {}", input.summary.trim())
            .chars()
            .take(72)
            .collect();
        let message = message.trim_end().to_string();
        must(
            git(&directory, &["commit", "-m", &message], &environment).await,
            "could not commit the documentation change",
        )?;
        (input.activity)(&format!(
            "documentation committed on {}",
            worktree.as_ref().expect("the worktree").branch
        ));
        let mut diff_arguments: Vec<&str> = vec!["diff", "--no-color", "HEAD^", "HEAD", "--"];
        diff_arguments.extend(paths.iter().map(String::as_str));
        let released_diff = must(
            git(&directory, &diff_arguments, &environment).await,
            "could not read the documentation diff",
        )?;
        default_checks(&directory, &input.config)?;
        must(
            git(&directory, &["fetch", "origin", "main"], &environment).await,
            "could not fetch origin/main",
        )?;
        let merged = git(&directory, &["merge", "--no-edit", "origin/main"], &environment).await;
        if merged.code != 0 {
            resolve_conflicts(&directory, &paths, &environment, &input.activity, false).await?;
            must(
                git(&directory, &["commit", "--no-edit"], &environment).await,
                "could not commit the conflict resolution",
            )?;
        }
        default_checks(&directory, &input.config)?;
        let diff = git(
            &directory,
            &["diff", "--name-only", "origin/main...HEAD"],
            &environment,
        )
        .await;
        let outside: Vec<String> = diff
            .stdout
            .lines()
            .map(str::trim)
            .filter(|path| !path.is_empty() && !paths.iter().any(|allowed| allowed == path))
            .map(str::to_string)
            .collect();
        if !outside.is_empty() {
            return Err(format!(
                "the cycle diff touches files outside the two documents: {}",
                outside.join(", ")
            ));
        }
        for attempt in 1..=PUSH_ATTEMPTS {
            let push = git(&directory, &["push", "origin", "HEAD:main"], &environment).await;
            if push.code == 0 {
                pushed = true;
                break;
            }
            let diagnostic = format!("{}\n{}", push.stderr, push.stdout).to_ascii_lowercase();
            let rejected = diagnostic.contains("rejected")
                || diagnostic.contains("non-fast-forward")
                || diagnostic.contains("fetch first");
            if !rejected {
                let detail = if push.stderr.trim().is_empty() {
                    first_line(&push.stdout)
                } else {
                    first_line(&push.stderr)
                };
                return Err(format!("could not push main: {detail}"));
            }
            (input.activity)(&format!(
                "push rejected; integrating origin/main and retrying (attempt {attempt})"
            ));
            must(
                git(&directory, &["fetch", "origin", "main"], &environment).await,
                "could not fetch after a rejected push",
            )?;
            let retry = git(&directory, &["merge", "--no-edit", "origin/main"], &environment).await;
            if retry.code != 0 {
                resolve_conflicts(&directory, &paths, &environment, &input.activity, true).await?;
                must(
                    git(&directory, &["commit", "--no-edit"], &environment).await,
                    "could not commit the retry resolution",
                )?;
            }
            default_checks(&directory, &input.config)?;
        }
        if !pushed {
            return Err("main rejected every push attempt".to_string());
        }
        let sha = must(
            git(&directory, &["rev-parse", "HEAD"], &environment).await,
            "could not read the pushed commit",
        )?;
        (input.activity)(&format!("pushed {} to main", short_sha(&sha)));
        must(
            git(&input.repo_dir, &["fetch", "origin", "main"], &environment).await,
            "could not fetch origin/main in the integration checkout",
        )?;
        let incoming = git(
            &input.repo_dir,
            &["diff", "--name-only", "HEAD", "origin/main"],
            &environment,
        )
        .await;
        let incoming_paths: Vec<String> = incoming
            .stdout
            .lines()
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(str::to_string)
            .collect();
        let dirty = git(
            &input.repo_dir,
            &["status", "--porcelain", "--untracked-files=no"],
            &environment,
        )
        .await;
        let dirty_paths: Vec<String> = dirty
            .stdout
            .lines()
            .map(|line| {
                line.split_whitespace()
                    .skip(1)
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .filter(|path| !path.is_empty())
            .collect();
        let blocking: Vec<String> = dirty_paths
            .into_iter()
            .filter(|path| incoming_paths.contains(path))
            .collect();
        if !blocking.is_empty() {
            return Err(format!(
                "uncommitted changes in the integration checkout block the fast-forward: {}",
                blocking.join(", ")
            ));
        }
        let ahead = must(
            git(&input.repo_dir, &["rev-parse", "HEAD"], &environment).await,
            "could not read the integration HEAD",
        )?;
        if ahead != sha {
            let fast_forward = git(
                &input.repo_dir,
                &["merge", "--ff-only", "origin/main"],
                &environment,
            )
            .await;
            if fast_forward.code != 0 {
                return Err(format!(
                    "the integration checkout cannot fast-forward to origin/main without discarding work: {}",
                    first_line(&fast_forward.stderr)
                ));
            }
        }
        let contains = git(
            &input.repo_dir,
            &["merge-base", "--is-ancestor", &sha, "HEAD"],
            &environment,
        )
        .await;
        if contains.code != 0 {
            return Err("the integration checkout does not contain the pushed commit".to_string());
        }
        let version = derive_version(&input.repo_dir, &sha);
        let url = commit_url(&input.repo_dir, &environment, &project, &sha);
        (input.activity)(&format!(
            "pushed documentation {}; the Release Train will release it",
            short_sha(&sha)
        ));
        let branch = worktree.as_ref().expect("the worktree").branch.clone();
        let mut files = changed.clone();
        files.sort();
        remove_worktree(&input.repo_dir, worktree.as_ref().expect("the worktree"), &environment)
            .await;
        worktree = None;
        Ok(ReleaseOk {
            version,
            url,
            sha,
            branch,
            files,
            diff: released_diff,
        })
    }
    .await;
    match outcome {
        Ok(ok) => ReleaseResult::Ok(ok),
        Err(detail) => {
            if pushed {
                if let Some(worktree) = worktree.as_ref() {
                    remove_worktree(&input.repo_dir, worktree, &environment).await;
                }
            }
            ReleaseResult::Failed(ReleaseFailure {
                detail,
                step: if pushed { "release" } else { "documentation" }.to_string(),
            })
        }
    }
}

fn short_sha(sha: &str) -> String {
    sha.chars().take(7).collect()
}

/* ------------------------------------------------------------------------ */
/* Audit turn                                                                */
/* ------------------------------------------------------------------------ */

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuditSignal {
    Activity { text: String, append: bool },
    SessionUpdate,
    Stderr(String),
}

#[derive(Clone)]
pub struct AuditTurn {
    pub directory: PathBuf,
    pub prompt: String,
    pub environment: HashMap<String, String>,
    pub signal: Arc<dyn Fn(AuditSignal) + Send + Sync>,
}

pub type AuditFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;
pub type AuditFn = Arc<dyn Fn(AuditTurn) -> AuditFuture + Send + Sync>;

fn bounded_line(text: &str) -> String {
    let line = text
        .split('\n')
        .map(str::trim)
        .find(|entry| !entry.is_empty())
        .unwrap_or("");
    if line.chars().count() <= FIRST_LINE_MAX {
        return line.to_string();
    }
    let mut bounded: String = line.chars().take(FIRST_LINE_MAX - 1).collect();
    bounded.push('…');
    bounded
}

/// The production audit turn: one ACP peer, its activity stream, and its
/// questions answered with the recommended option.
pub async fn acp_audit_turn(command: String, turn: AuditTurn) -> Result<(), String> {
    let mcp_servers = session_mcp_servers(&turn.environment);
    let options = AcpConnectionOptions::new(command, turn.directory.to_string_lossy().into_owned())
        .with_starter("Design System")
        .with_env(turn.environment.clone())
        .with_mcp_servers(mcp_servers)
        .with_permission_policy(PermissionPolicy::Allow);
    let (connection, mut events) = AcpConnection::connect(options)
        .await
        .map_err(|error| error.message)?;
    let connection = Arc::new(connection);
    let signal = turn.signal.clone();
    let answers = Arc::clone(&connection);
    let reader = tokio::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                AcpEvent::Activity(AcpActivity { text, append }) => {
                    signal(AuditSignal::Activity { text, append });
                }
                AcpEvent::SessionUpdate => signal(AuditSignal::SessionUpdate),
                AcpEvent::Stderr(text) => signal(AuditSignal::Stderr(text)),
                AcpEvent::Question(question) => {
                    answer_question(&answers, &signal, question).await;
                }
                AcpEvent::Text(_) => {}
            }
        }
    });
    let result = connection.run(&turn.prompt).await;
    connection.close();
    reader.abort();
    match result {
        Ok(_) => Ok(()),
        Err(error) => Err(error.message),
    }
}

async fn answer_question(
    connection: &AcpConnection,
    signal: &Arc<dyn Fn(AuditSignal) + Send + Sync>,
    question: AcpQuestion,
) {
    signal(AuditSignal::Activity {
        text: format!("question: {}", question.message),
        append: false,
    });
    let option = question
        .options
        .iter()
        .find(|option| option.recommended)
        .or_else(|| question.options.first());
    let value = option
        .map(|option| option.label.clone())
        .unwrap_or_default();
    let answered = connection.answer(&question.id, &value).await;
    signal(AuditSignal::Activity {
        text: if answered {
            if value.is_empty() {
                "answer: (no options offered)".to_string()
            } else {
                format!("answer: {value}")
            }
        } else {
            "answer: failed".to_string()
        },
        append: false,
    });
}

/* ------------------------------------------------------------------------ */
/* Worker                                                                    */
/* ------------------------------------------------------------------------ */

pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
pub type LogFn = Arc<dyn Fn(&str) + Send + Sync>;
pub type ProviderEnvironmentFn = Arc<
    dyn Fn() -> Pin<Box<dyn Future<Output = Result<HashMap<String, String>, String>> + Send>>
        + Send
        + Sync,
>;

pub struct DesignWorkerOptions {
    pub repo_dir: PathBuf,
    pub state_dir: PathBuf,
    pub agent_command: Option<String>,
    pub environment: HashMap<String, String>,
    pub sync_ms: Option<u64>,
    pub cadence_ms: Option<u64>,
    pub tick_ms: Option<u64>,
    pub read_timeout_ms: Option<u64>,
    pub timeout_ms: Option<u64>,
    pub harness_version: Option<String>,
    pub config: Option<DesignConfig>,
    pub manual_cycles: bool,
    pub now: Option<Clock>,
    pub forge: Option<Arc<dyn DesignForge>>,
    pub release: Option<ReleaseFn>,
    pub audit: Option<AuditFn>,
    pub provider_environment: Option<ProviderEnvironmentFn>,
    pub log: Option<LogFn>,
    pub argv: Vec<String>,
    pub on_stopped: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl DesignWorkerOptions {
    pub fn new(repo_dir: impl Into<PathBuf>, state_dir: impl Into<PathBuf>) -> Self {
        Self {
            repo_dir: repo_dir.into(),
            state_dir: state_dir.into(),
            agent_command: None,
            environment: crate::forge::process_environment(),
            sync_ms: None,
            cadence_ms: None,
            tick_ms: None,
            read_timeout_ms: None,
            timeout_ms: None,
            harness_version: None,
            config: None,
            manual_cycles: false,
            now: None,
            forge: None,
            release: None,
            audit: None,
            provider_environment: None,
            log: None,
            argv: Vec::new(),
            on_stopped: None,
        }
    }
}

struct ResolvedOptions {
    repo_dir: PathBuf,
    state_dir: PathBuf,
    sync_ms: u64,
    cadence_override_ms: Option<u64>,
    tick_ms: u64,
    read_timeout_ms: u64,
    timeout_ms: u64,
    environment: HashMap<String, String>,
    clock: Clock,
    harness_version: Option<String>,
    config: DesignConfig,
    manual_cycles: bool,
    release: ReleaseFn,
    audit: AuditFn,
    forge: Option<Arc<dyn DesignForge>>,
    provider_environment: Option<ProviderEnvironmentFn>,
    log: LogFn,
    argv: Vec<String>,
    on_stopped: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl ResolvedOptions {
    fn from_options(mut options: DesignWorkerOptions) -> Self {
        let repo_dir = resolve(&options.repo_dir);
        let state_dir = resolve(&options.state_dir);
        let clock: Clock = options.now.take().unwrap_or_else(|| Arc::new(now_millis));
        let agent_command = options
            .agent_command
            .take()
            .filter(|command| !command.trim().is_empty())
            .or_else(|| {
                options
                    .environment
                    .get("AGENT_COMMAND")
                    .filter(|command| !command.trim().is_empty())
                    .cloned()
            })
            .or_else(|| {
                std::env::var("AGENT_COMMAND")
                    .ok()
                    .filter(|command| !command.trim().is_empty())
            })
            .unwrap_or_else(|| DEFAULT_AGENT_COMMAND.to_string());
        let environment = options.environment.clone();
        let release: ReleaseFn = options
            .release
            .take()
            .unwrap_or_else(|| Arc::new(|input| Box::pin(release_documents(input))));
        let command = agent_command.clone();
        let audit: AuditFn = options.audit.take().unwrap_or_else(|| {
            Arc::new(move |turn: AuditTurn| {
                let command = command.clone();
                Box::pin(acp_audit_turn(command, turn))
            })
        });
        let forge = options.forge.take();
        Self {
            repo_dir,
            state_dir,
            sync_ms: options.sync_ms.unwrap_or(SYNC_INTERVAL_MS).max(1_000),
            cadence_override_ms: options.cadence_ms,
            tick_ms: options.tick_ms.unwrap_or(TICK_MS).max(1),
            read_timeout_ms: options.read_timeout_ms.unwrap_or(READ_TIMEOUT_MS).max(1),
            timeout_ms: options.timeout_ms.unwrap_or(CYCLE_TIMEOUT_MS).max(1_000),
            environment,
            clock,
            harness_version: options.harness_version,
            config: options
                .config
                .unwrap_or_else(|| design_config(&options.environment)),
            manual_cycles: options.manual_cycles,
            release,
            audit,
            forge,
            provider_environment: options.provider_environment.take(),
            log: options
                .log
                .take()
                .unwrap_or_else(|| Arc::new(|_line: &str| {})),
            argv: options.argv.clone(),
            on_stopped: options.on_stopped.take(),
        }
    }
}

#[derive(Clone)]
pub struct DesignWorker {
    inner: Arc<DesignWorkerInner>,
}

struct ActiveCycle {
    cycle_id: String,
    directory: PathBuf,
    activity: Arc<Mutex<Vec<String>>>,
    documents: Vec<AuditFile>,
    stop: Arc<tokio::sync::Notify>,
    first_line: Mutex<Option<String>>,
    finished: bool,
}

struct CycleSignal {
    done: AtomicBool,
    notify: tokio::sync::Notify,
}

impl CycleSignal {
    fn new() -> Self {
        Self {
            done: AtomicBool::new(false),
            notify: tokio::sync::Notify::new(),
        }
    }

    fn finish(&self) {
        self.done.store(true, Ordering::SeqCst);
        self.notify.notify_one();
    }

    async fn wait(&self) {
        while !self.done.load(Ordering::SeqCst) {
            self.notify.notified().await;
        }
    }
}

struct DesignWorkerInner {
    options: ResolvedOptions,
    state: Mutex<DesignState>,
    last_saved: Mutex<String>,
    forge: Mutex<Option<Arc<dyn DesignForge>>>,
    syncing: AtomicBool,
    starting: AtomicBool,
    cycle_running: AtomicBool,
    stopping: AtomicBool,
    draining: AtomicBool,
    consuming: AtomicBool,
    next_sync_at: AtomicI64,
    retry: Mutex<crate::forge::ForgeReadRetry>,
    open_titles: Mutex<Vec<String>>,
    lock: Mutex<Option<LockGuard>>,
    cycle_claim: Mutex<Option<LockGuard>>,
    active: Mutex<Option<ActiveCycle>>,
    cycle_signal: Mutex<Option<Arc<CycleSignal>>>,
    stop_signal: Mutex<Option<Arc<CycleSignal>>>,
    ticker: Mutex<Option<tokio::task::JoinHandle<()>>>,
    stopped: tokio::sync::Notify,
}

impl DesignWorker {
    pub fn new(options: DesignWorkerOptions) -> Self {
        let resolved = ResolvedOptions::from_options(options);
        let now = (resolved.clock)();
        let state = empty_state("", &resolved.repo_dir, now);
        Self {
            inner: Arc::new(DesignWorkerInner {
                options: resolved,
                state: Mutex::new(state),
                last_saved: Mutex::new(String::new()),
                forge: Mutex::new(None),
                syncing: AtomicBool::new(false),
                starting: AtomicBool::new(false),
                cycle_running: AtomicBool::new(false),
                stopping: AtomicBool::new(false),
                draining: AtomicBool::new(false),
                consuming: AtomicBool::new(false),
                next_sync_at: AtomicI64::new(0),
                retry: Mutex::new(crate::forge::ForgeReadRetry::new()),
                open_titles: Mutex::new(Vec::new()),
                lock: Mutex::new(None),
                cycle_claim: Mutex::new(None),
                active: Mutex::new(None),
                cycle_signal: Mutex::new(None),
                stop_signal: Mutex::new(None),
                ticker: Mutex::new(None),
                stopped: tokio::sync::Notify::new(),
            }),
        }
    }

    pub fn current_state(&self) -> DesignState {
        lock_unpoisoned(&self.inner.state).clone()
    }

    pub fn cycling_now(&self) -> bool {
        self.inner.cycle_running.load(Ordering::SeqCst)
    }

    /// Takes the repository lock and publishes a fresh `idle` state.
    pub fn start(&self, repository: &str) -> bool {
        let inner = &self.inner;
        let lock_result = acquire_lock(
            &versioned_lock_path(
                &inner.options.repo_dir,
                inner.options.harness_version.as_deref(),
            ),
            &LockDetails {
                repo: inner.options.repo_dir.to_string_lossy().into_owned(),
                state_dir: inner.options.state_dir.to_string_lossy().into_owned(),
                harness_version: inner.options.harness_version.clone(),
                argv: inner.options.argv.clone(),
            },
        );
        let Some(guard) = lock_result.acquired() else {
            let version = inner
                .options
                .harness_version
                .clone()
                .unwrap_or_else(|| "an unknown version".to_string());
            (inner.options.log)(&format!(
                "already running for {} on {version}",
                inner.options.repo_dir.display()
            ));
            return false;
        };
        *lock_unpoisoned(&inner.lock) = Some(guard);

        let previous = inherited_state_path(
            &versioned_state_path(
                &inner.options.state_dir,
                &inner.options.repo_dir,
                inner.options.harness_version.as_deref(),
            ),
            &versioned_state_files(&worker_state_directories(
                &inner.options.state_dir,
                &inner.options.repo_dir,
            )),
            &state_path(&inner.options.state_dir, &inner.options.repo_dir),
        )
        .and_then(|path| load_state(&path));
        let now = (inner.options.clock)();
        let now_text = iso_from_millis(now);
        let settings = read_settings(&settings_path(
            &inner.options.state_dir,
            &inner.options.repo_dir,
        ))
        .unwrap_or_else(|| {
            let limits = previous
                .as_ref()
                .map(|state| state.limits.clone())
                .unwrap_or_default();
            DesignSettings {
                max_per_hour: limits.max_per_hour,
                max_pending: limits.max_pending,
                interval_minutes: previous
                    .as_ref()
                    .map(|state| state.interval_minutes)
                    .unwrap_or(DEFAULT_INTERVAL_MINUTES),
            }
        });
        let mut state = empty_state(repository, &inner.options.repo_dir, now);
        state.lifecycle = DesignLifecycle::Idle;
        state.enabled = true;
        state.worker = Some(DesignWorkerRecord {
            pid: std::process::id(),
            started_at: now_text.clone(),
            state_dir: inner.options.state_dir.to_string_lossy().into_owned(),
            harness_version: inner.options.harness_version.clone(),
            argv: inner.options.argv.clone(),
        });
        state.limits = DesignLimits {
            max_per_hour: settings.max_per_hour,
            max_pending: settings.max_pending,
        };
        state.interval_minutes = settings.interval_minutes;
        if let Some(previous) = &previous {
            state.last_cycle_started_at = previous.last_cycle_started_at.clone();
            state.issues = previous.issues.clone();
            state.sync = previous.sync.clone();
            state.newest_cycle_id = previous.newest_cycle_id.clone();
            state.release = previous.release.clone();
            state.documentation = previous.documentation.clone();
            state.notice = previous.notice.clone();
        }
        state.last_error = None;
        state.updated_at = now_text;
        *lock_unpoisoned(&inner.state) = state;
        let forge = self
            .inner
            .options
            .forge
            .clone()
            .or_else(|| self.inner.options_forge(repository));
        *lock_unpoisoned(&inner.forge) = forge;
        inner.next_sync_at.store(0, Ordering::SeqCst);
        inner.publish();
        inner.start_ticker();
        true
    }

    pub async fn refresh(&self) {
        self.inner.refresh().await;
    }

    pub async fn begin_cycle(&self) {
        self.inner.begin_cycle().await;
    }

    /// Resolves when the cycle running now reaches a terminal state.
    pub async fn wait_for_cycle(&self) {
        let signal = lock_unpoisoned(&self.inner.cycle_signal).clone();
        if let Some(signal) = signal {
            signal.wait().await;
        }
    }

    pub async fn tick_now(&self) {
        self.inner.tick().await;
    }

    pub async fn stop(&self) {
        self.inner.stop().await;
    }

    pub async fn shutdown(&self) {
        self.stop().await;
    }

    pub async fn stopped(&self) {
        self.inner.stopped.notified().await;
    }
}

impl DesignWorkerInner {
    fn options_forge(&self, repository: &str) -> Option<Arc<dyn DesignForge>> {
        let options = &self.options;
        create_design_forge(
            repository,
            &options.repo_dir,
            &options.environment,
            options.read_timeout_ms,
        )
        .map_err(|detail| (options.log)(&format!("could not build the forge client: {detail}")))
        .ok()
    }

    fn publish(&self) {
        let mut state = lock_unpoisoned(&self.state);
        state.updated_at = iso_from_millis((self.options.clock)());
        let text = match serde_json::to_string(&*state) {
            Ok(text) => text,
            Err(error) => {
                (self.options.log)(&format!("could not serialize state: {error}"));
                return;
            }
        };
        {
            let mut last = lock_unpoisoned(&self.last_saved);
            if *last == text {
                return;
            }
            if let Err(error) = write_state(
                &versioned_state_path(
                    &self.options.state_dir,
                    &self.options.repo_dir,
                    self.options.harness_version.as_deref(),
                ),
                &state,
            ) {
                (self.options.log)(&format!("could not write state: {error}"));
                return;
            }
            *last = text;
        }
    }

    fn start_ticker(self: &Arc<Self>) {
        let mut slot = lock_unpoisoned(&self.ticker);
        if slot.is_some() {
            return;
        }
        let inner = Arc::clone(self);
        let tick_ms = self.options.tick_ms;
        let handle = tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(tick_ms)).await;
                if inner.stopping.load(Ordering::SeqCst) {
                    break;
                }
                inner.tick().await;
            }
        });
        *slot = Some(handle);
    }

    async fn tick(self: &Arc<Self>) {
        if self.stopping.load(Ordering::SeqCst) {
            return;
        }
        self.consume_commands().await;
        if self.stopping.load(Ordering::SeqCst) {
            return;
        }
        if !lock_unpoisoned(&self.state).enabled {
            return;
        }
        if self.draining.load(Ordering::SeqCst) {
            self.leave_if_idle().await;
            return;
        }
        self.mark_stale();
        if self.syncing.load(Ordering::SeqCst) || self.cycle_running.load(Ordering::SeqCst) {
            return;
        }
        let now = (self.options.clock)();
        if now >= self.next_sync_at.load(Ordering::SeqCst) {
            self.refresh().await;
            if self.stopping.load(Ordering::SeqCst) {
                return;
            }
            if !lock_unpoisoned(&self.state).enabled {
                return;
            }
            if self.draining.load(Ordering::SeqCst) {
                self.leave_if_idle().await;
                return;
            }
        }
        if lock_unpoisoned(&self.active).is_some() || self.starting.load(Ordering::SeqCst) {
            return;
        }
        if lock_unpoisoned(&self.state).sync.state != DesignSyncState::Ok {
            return;
        }
        if self.options.manual_cycles || self.cadence_remaining() {
            return;
        }
        self.begin_cycle().await;
    }

    async fn leave_if_idle(&self) {
        if lock_unpoisoned(&self.active).is_none()
            && !self.cycle_running.load(Ordering::SeqCst)
            && !self.starting.load(Ordering::SeqCst)
        {
            self.stop().await;
        }
    }

    fn mark_stale(&self) {
        if self.cycle_running.load(Ordering::SeqCst) {
            return;
        }
        let now = (self.options.clock)();
        let mut state = lock_unpoisoned(&self.state);
        if state.sync.state != DesignSyncState::Ok {
            return;
        }
        let Some(at) = state.sync.at.clone() else {
            return;
        };
        let Some(last) = parse_iso_millis(&at) else {
            return;
        };
        if now - last <= 2 * self.options.sync_ms as i64 {
            return;
        }
        state.sync = DesignSync {
            state: DesignSyncState::Stale,
            at: Some(at),
            error: Some(format!(
                "no forge read has succeeded for more than {} seconds",
                ((2 * self.options.sync_ms) / 1000)
            )),
        };
        drop(state);
        self.publish();
    }

    fn cadence_ms(&self) -> i64 {
        match self.options.cadence_override_ms {
            Some(value) => value as i64,
            None => lock_unpoisoned(&self.state).interval_minutes * 60_000,
        }
    }

    fn cadence_remaining(&self) -> bool {
        // The anchor is read under the lock and the cadence after it is released:
        // `cadence_ms` takes the same mutex, so holding it here would deadlock the
        // tick that follows a recorded cycle.
        let last_cycle_started_at = lock_unpoisoned(&self.state).last_cycle_started_at.clone();
        let Some(started) = last_cycle_started_at.as_deref().and_then(parse_iso_millis) else {
            return false;
        };
        (self.options.clock)() < started + self.cadence_ms()
    }

    fn cadence_ready_at(&self, now: i64) -> Option<String> {
        let last_cycle_started_at = lock_unpoisoned(&self.state).last_cycle_started_at.clone();
        let started = parse_iso_millis(last_cycle_started_at.as_deref()?)?;
        let ready = started + self.cadence_ms();
        if ready > now {
            Some(iso_from_millis(ready))
        } else {
            None
        }
    }

    async fn consume_commands(&self) {
        if self.consuming.swap(true, Ordering::SeqCst) {
            return;
        }
        let mut directories: Vec<PathBuf> = vec![versioned_control_directory(
            &self.options.state_dir,
            &self.options.repo_dir,
            self.options.harness_version.as_deref(),
        )];
        let legacy_live = live_lock_owners(&lock_path(&self.options.repo_dir))
            .iter()
            .any(|owner| owner.harness_version.is_none() && owner.pid != std::process::id());
        if !legacy_live {
            directories.push(control_directory(
                &self.options.state_dir,
                &self.options.repo_dir,
            ));
        }
        let mut seen = HashSet::new();
        directories.retain(|directory| seen.insert(directory.clone()));
        for directory in directories {
            for command in take_commands(&directory) {
                if self.stopping.load(Ordering::SeqCst) {
                    self.consuming.store(false, Ordering::SeqCst);
                    return;
                }
                self.apply_command(command).await;
            }
        }
        self.consuming.store(false, Ordering::SeqCst);
    }

    async fn apply_command(&self, command: DesignCommand) {
        match command {
            DesignCommand::Stop => {
                self.stop().await;
            }
            DesignCommand::Drain => {
                self.draining.store(true, Ordering::SeqCst);
                let mut state = lock_unpoisoned(&self.state);
                state.draining = true;
                state.last_error = None;
                state.notice =
                    Some("Draining: this worker exits after its in-flight cycle.".to_string());
                drop(state);
                self.publish();
            }
            DesignCommand::Limits {
                max_per_hour,
                max_pending,
            } => {
                if !is_valid_limit(max_per_hour) || !is_valid_limit(max_pending) {
                    let mut state = lock_unpoisoned(&self.state);
                    state.last_error = Some(
                        "Design System limits must be empty or integers from 1 through 100."
                            .to_string(),
                    );
                    drop(state);
                    self.publish();
                    return;
                }
                {
                    let mut state = lock_unpoisoned(&self.state);
                    state.limits = DesignLimits {
                        max_per_hour,
                        max_pending,
                    };
                }
                self.persist_settings();
                let mut state = lock_unpoisoned(&self.state);
                state.last_error = None;
                state.notice = Some(format!(
                    "Limits saved: {} per hour, {} open.",
                    limit_label(state.limits.max_per_hour),
                    limit_label(state.limits.max_pending)
                ));
                drop(state);
                self.publish();
            }
            DesignCommand::Cadence { interval_minutes } => {
                if !is_valid_cadence(interval_minutes) {
                    let mut state = lock_unpoisoned(&self.state);
                    state.last_error =
                        Some("Design System cadence must be 1 through 1440 minutes.".to_string());
                    drop(state);
                    self.publish();
                    return;
                }
                {
                    let mut state = lock_unpoisoned(&self.state);
                    state.interval_minutes = interval_minutes;
                }
                self.persist_settings();
                let mut state = lock_unpoisoned(&self.state);
                state.last_error = None;
                state.notice = Some(format!(
                    "Cadence saved: every {interval_minutes} minute(s)."
                ));
                drop(state);
                self.publish();
            }
            DesignCommand::Settings {
                interval_minutes,
                max_per_hour,
                max_pending,
            } => {
                if !is_valid_cadence(interval_minutes)
                    || !is_valid_limit(max_per_hour)
                    || !is_valid_limit(max_pending)
                {
                    let mut state = lock_unpoisoned(&self.state);
                    state.last_error = Some(
                        "Design System settings must be 1 through 1440 minutes and nullable 1..100 caps."
                            .to_string(),
                    );
                    drop(state);
                    self.publish();
                    return;
                }
                {
                    let mut state = lock_unpoisoned(&self.state);
                    state.interval_minutes = interval_minutes;
                    state.limits = DesignLimits {
                        max_per_hour,
                        max_pending,
                    };
                }
                self.persist_settings();
                let mut state = lock_unpoisoned(&self.state);
                state.last_error = None;
                state.notice = Some("Settings saved.".to_string());
                drop(state);
                self.publish();
            }
        }
    }

    fn persist_settings(&self) {
        let settings = {
            let state = lock_unpoisoned(&self.state);
            DesignSettings {
                max_per_hour: state.limits.max_per_hour,
                max_pending: state.limits.max_pending,
                interval_minutes: state.interval_minutes,
            }
        };
        if let Err(error) = write_settings(
            &settings_path(&self.options.state_dir, &self.options.repo_dir),
            &settings,
        ) {
            (self.options.log)(&format!("could not persist settings: {error}"));
        }
    }

    fn capacity(&self) -> DesignCapacity {
        let state = lock_unpoisoned(&self.state);
        capacity_for(&state.issues, &state.limits, (self.options.clock)())
    }

    fn forge_client(&self) -> Option<Arc<dyn DesignForge>> {
        lock_unpoisoned(&self.forge).clone()
    }

    /// The labelled issues and the release list, read together.
    ///
    /// The open-issue titles are not part of the periodic read: only a cycle
    /// consumes them, so `begin_cycle` reads them where they are used. Keeping
    /// that whole-history walk out of every sync keeps one periodic read inside
    /// its deadline, and the two remaining requests share the deadline instead
    /// of spending it one after the other.
    async fn read_forge(&self) -> Result<ForgeRead, String> {
        let Some(forge) = self.forge_client() else {
            return Err("no forge client is configured".to_string());
        };
        let (issues, releases) = tokio::join!(forge.list_issues(), forge.list_releases());
        Ok(ForgeRead {
            issues: issues?,
            releases: releases?,
        })
    }

    async fn read_forge_within_deadline(&self) -> Result<ForgeRead, String> {
        match tokio::time::timeout(
            Duration::from_millis(self.options.read_timeout_ms),
            self.read_forge(),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => Err(format!(
                "the forge read did not finish within {} ms",
                self.options.read_timeout_ms
            )),
        }
    }

    /// The open-issue titles a cycle needs for its duplicate check.
    ///
    /// Best effort: a failure is logged and the last known titles stay in use,
    /// so a slow forge never blocks a cycle.
    async fn refresh_open_titles(&self) {
        let Some(forge) = self.forge_client() else {
            return;
        };
        match tokio::time::timeout(
            Duration::from_millis(self.options.read_timeout_ms),
            forge.list_open_issue_titles(),
        )
        .await
        {
            Ok(Ok(titles)) => *lock_unpoisoned(&self.open_titles) = titles,
            Ok(Err(detail)) => {
                (self.options.log)(&format!("could not read open issue titles: {detail}"))
            }
            Err(_) => (self.options.log)(&format!(
                "could not read open issue titles: the forge read did not finish within {} ms",
                self.options.read_timeout_ms
            )),
        }
    }

    async fn refresh(&self) {
        if self.stopping.load(Ordering::SeqCst) {
            return;
        }
        if !lock_unpoisoned(&self.state).enabled || self.cycle_running.load(Ordering::SeqCst) {
            return;
        }
        if self.syncing.swap(true, Ordering::SeqCst) {
            return;
        }
        let read = self.read_forge_within_deadline().await;
        match read {
            Err(detail) => {
                self.record_sync_failure(&detail);
            }
            Ok(read) => {
                let now = (self.options.clock)();
                self.apply_read(read).await;
                lock_unpoisoned(&self.retry).succeed();
                self.next_sync_at
                    .store(now + self.options.sync_ms as i64, Ordering::SeqCst);
                self.publish();
            }
        }
        self.syncing.store(false, Ordering::SeqCst);
    }

    fn record_sync_failure(&self, detail: &str) {
        let now = (self.options.clock)();
        let kind = crate::forge::classify_forge_read_failure(detail);
        if kind == crate::forge::ForgeReadFailureKind::Transient {
            let delay = lock_unpoisoned(&self.retry).record(kind);
            if let Some(delay) = delay {
                let mut state = lock_unpoisoned(&self.state);
                state.sync = DesignSync {
                    state: DesignSyncState::Stale,
                    at: state.sync.at.clone(),
                    error: None,
                };
                drop(state);
                self.next_sync_at
                    .store(now + delay as i64, Ordering::SeqCst);
                self.publish();
                return;
            }
        } else {
            lock_unpoisoned(&self.retry).record(kind);
        }
        let mut state = lock_unpoisoned(&self.state);
        state.sync = DesignSync {
            state: DesignSyncState::Error,
            at: state.sync.at.clone(),
            error: Some(detail.to_string()),
        };
        state.last_error =
            if kind == crate::forge::ForgeReadFailureKind::RateLimit || rate_limited(detail) {
                None
            } else {
                Some(detail.to_string())
            };
        state.notice = Some(format!("Could not read the forge: {detail}"));
        drop(state);
        self.next_sync_at
            .store(now + self.options.sync_ms as i64, Ordering::SeqCst);
        self.publish();
    }

    async fn apply_read(&self, read: ForgeRead) {
        let forge = self.forge_client();
        let previous: HashMap<i64, DesignIssueRow> = {
            let state = lock_unpoisoned(&self.state);
            state
                .issues
                .iter()
                .map(|row| (row.number, row.clone()))
                .collect()
        };
        let mut rows = Vec::new();
        for issue in read.issues {
            let before = previous.get(&issue.number);
            let implemented = issue.state == ForgeIssueState::Closed;
            let category = before
                .and_then(|row| row.category.clone())
                .or_else(|| category_from_body(&issue.body));
            let mut version = if implemented {
                before.and_then(|row| row.version.clone())
            } else {
                None
            };
            if implemented && version.is_none() {
                if let Some(forge) = &forge {
                    if let Ok(Some(shipped)) = forge
                        .shipped_version(issue.clone(), read.releases.clone())
                        .await
                    {
                        version = Some(shipped);
                    }
                }
            }
            rows.push(DesignIssueRow {
                number: issue.number,
                title: issue.title,
                url: issue.url,
                created_at: issue.created_at,
                state: if implemented {
                    DesignIssueState::Implemented
                } else {
                    DesignIssueState::Pending
                },
                category,
                version,
            });
        }
        newest_first(&mut rows);
        let mut state = lock_unpoisoned(&self.state);
        state.issues = rows;
        state.sync = DesignSync {
            state: DesignSyncState::Ok,
            at: Some(iso_from_millis((self.options.clock)())),
            error: None,
        };
        if !rate_limited(state.last_error.as_deref().unwrap_or("")) {
            state.last_error = None;
        }
        drop(state);
    }

    async fn resolve_provider_environment(&self) -> Result<HashMap<String, String>, String> {
        if let Some(resolver) = &self.options.provider_environment {
            return resolver().await;
        }
        let environment: HashMap<String, Option<String>> = self
            .options
            .environment
            .iter()
            .map(|(key, value)| (key.clone(), Some(value.clone())))
            .collect();
        let resolved = crate::providers::worker_peer_environment(
            &self.options.state_dir,
            &self.options.repo_dir,
            environment,
            crate::providers::ProviderOptions::default(),
        )
        .await
        .map_err(|error| error.message)?;
        Ok(resolved
            .into_iter()
            .filter_map(|(key, value)| value.map(|value| (key, value)))
            .collect())
    }

    async fn begin_cycle(self: &Arc<Self>) {
        if self.stopping.load(Ordering::SeqCst)
            || self.draining.load(Ordering::SeqCst)
            || lock_unpoisoned(&self.active).is_some()
            || self.cycle_running.load(Ordering::SeqCst)
        {
            return;
        }
        if !lock_unpoisoned(&self.state).enabled {
            return;
        }
        if self.starting.swap(true, Ordering::SeqCst) {
            return;
        }
        if self.cycle_running.swap(true, Ordering::SeqCst) {
            self.starting.store(false, Ordering::SeqCst);
            return;
        }
        let claim = acquire_lock(
            &cycle_claim_path(&self.options.repo_dir),
            &LockDetails {
                repo: self.options.repo_dir.to_string_lossy().into_owned(),
                state_dir: self.options.state_dir.to_string_lossy().into_owned(),
                harness_version: self.options.harness_version.clone(),
                argv: self.options.argv.clone(),
            },
        );
        let Some(claim) = claim.acquired() else {
            self.cycle_running.store(false, Ordering::SeqCst);
            self.starting.store(false, Ordering::SeqCst);
            return;
        };
        *lock_unpoisoned(&self.cycle_claim) = Some(claim);
        let signal = Arc::new(CycleSignal::new());
        *lock_unpoisoned(&self.cycle_signal) = Some(Arc::clone(&signal));

        let now = (self.options.clock)();
        {
            let mut state = lock_unpoisoned(&self.state);
            state.last_cycle_started_at = Some(iso_from_millis(now));
        }
        let input = match read_audit_input(&self.options.repo_dir, &self.options.config) {
            Ok(input) => input,
            Err(detail) => {
                let mut state = lock_unpoisoned(&self.state);
                state.lifecycle = DesignLifecycle::Idle;
                state.last_error = Some(detail.clone());
                state.notice = Some(format!("Audit failed: {detail}"));
                state.next_attempt_at = Some(iso_from_millis(now + self.options.sync_ms as i64));
                drop(state);
                self.publish();
                self.cycle_running.store(false, Ordering::SeqCst);
                self.release_cycle_claim();
                self.starting.store(false, Ordering::SeqCst);
                signal.finish();
                if self.draining.load(Ordering::SeqCst) {
                    self.spawn_stop();
                }
                return;
            }
        };
        let created = create_cycle_directory(&self.options.repo_dir, now);
        let (cycle_id, directory) = match created {
            Ok(created) => created,
            Err(detail) => {
                let mut state = lock_unpoisoned(&self.state);
                state.lifecycle = DesignLifecycle::Idle;
                state.last_error = Some(detail.clone());
                state.notice = Some(format!("Audit failed: {detail}"));
                state.next_attempt_at = Some(iso_from_millis(now + self.options.sync_ms as i64));
                drop(state);
                self.publish();
                self.cycle_running.store(false, Ordering::SeqCst);
                self.release_cycle_claim();
                self.starting.store(false, Ordering::SeqCst);
                signal.finish();
                if self.draining.load(Ordering::SeqCst) {
                    self.spawn_stop();
                }
                return;
            }
        };
        // The duplicate-title check consumes the open titles, so they are read
        // here, once per cycle, instead of on every periodic sync.
        self.refresh_open_titles().await;
        let capacity = self.capacity();
        let known_titles = {
            let state = lock_unpoisoned(&self.state);
            let mut titles: Vec<String> = state
                .issues
                .iter()
                .map(|issue| issue.title.clone())
                .collect();
            titles.extend(lock_unpoisoned(&self.open_titles).clone());
            titles
        };
        let request = match write_cycle(
            &directory,
            &WriteCycleOptions {
                cycle_id: cycle_id.clone(),
                repository: lock_unpoisoned(&self.state).repo.clone(),
                repo_dir: self.options.repo_dir.clone(),
                input: input.clone(),
                config: self.options.config.clone(),
                known_titles,
                issue_room: capacity.batch,
                now_ms: now,
                environment: self.options.environment.clone(),
            },
        ) {
            Ok(request) => request,
            Err(detail) => {
                let mut state = lock_unpoisoned(&self.state);
                state.lifecycle = DesignLifecycle::Idle;
                state.last_error = Some(detail.clone());
                state.notice = Some(format!("Audit failed: {detail}"));
                state.next_attempt_at = Some(iso_from_millis(now + self.options.sync_ms as i64));
                drop(state);
                self.publish();
                self.cycle_running.store(false, Ordering::SeqCst);
                self.release_cycle_claim();
                self.starting.store(false, Ordering::SeqCst);
                signal.finish();
                if self.draining.load(Ordering::SeqCst) {
                    self.spawn_stop();
                }
                return;
            }
        };
        let activity: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![format!(
            "entry point {}:{} (seed {})",
            request.entry_point.path, request.entry_point.line, request.seed
        )]));
        write_activity(&directory, &lock_unpoisoned(&activity).clone());
        self.record(
            &activity,
            &directory,
            &format!(
                "cycle {cycle_id}: read {} interface file(s) and {} document(s); room {}",
                input.sources.len(),
                input.documents.len(),
                capacity.batch
            ),
        );

        let environment = match self.resolve_provider_environment().await {
            Ok(environment) => environment,
            Err(detail) => {
                let mut state = lock_unpoisoned(&self.state);
                state.newest_cycle_id = Some(cycle_id.clone());
                state.lifecycle = DesignLifecycle::Idle;
                state.last_error = Some(detail.clone());
                state.notice = Some(format!("Audit failed: {detail}"));
                state.next_attempt_at = Some(iso_from_millis(now + self.options.sync_ms as i64));
                drop(state);
                self.publish();
                self.cycle_running.store(false, Ordering::SeqCst);
                self.release_cycle_claim();
                self.starting.store(false, Ordering::SeqCst);
                signal.finish();
                if self.draining.load(Ordering::SeqCst) {
                    self.spawn_stop();
                }
                return;
            }
        };
        if self.stopping.load(Ordering::SeqCst) {
            self.cycle_running.store(false, Ordering::SeqCst);
            self.release_cycle_claim();
            self.starting.store(false, Ordering::SeqCst);
            signal.finish();
            return;
        }
        let mut turn_environment = environment;
        turn_environment.insert(
            "REPO_DIR".to_string(),
            self.options.repo_dir.to_string_lossy().into_owned(),
        );
        turn_environment.insert(
            "STATE_DIR".to_string(),
            self.options.state_dir.to_string_lossy().into_owned(),
        );
        turn_environment.insert(
            "DEVBOARD_TOOL_LOG".to_string(),
            directory
                .join("tool-log.jsonl")
                .to_string_lossy()
                .into_owned(),
        );
        let stop = Arc::new(tokio::sync::Notify::new());
        let active = ActiveCycle {
            cycle_id: cycle_id.clone(),
            directory: directory.clone(),
            activity: Arc::clone(&activity),
            documents: input.documents.clone(),
            stop: Arc::clone(&stop),
            first_line: Mutex::new(None),
            finished: false,
        };
        *lock_unpoisoned(&self.active) = Some(active);
        if self.stopping.load(Ordering::SeqCst) {
            *lock_unpoisoned(&self.active) = None;
            self.cycle_running.store(false, Ordering::SeqCst);
            self.release_cycle_claim();
            self.starting.store(false, Ordering::SeqCst);
            signal.finish();
            return;
        }
        {
            let mut state = lock_unpoisoned(&self.state);
            state.newest_cycle_id = Some(cycle_id.clone());
            state.lifecycle = DesignLifecycle::Auditing;
            state.last_error = None;
            state.next_attempt_at = None;
        }
        self.publish();
        let heartbeat = CycleHeartbeat::new();
        let turn = AuditTurn {
            directory: directory.clone(),
            prompt: prompt_for(&directory),
            environment: turn_environment,
            signal: self.audit_signal(&cycle_id, Arc::clone(&heartbeat)),
        };
        let inner = Arc::clone(self);
        let audit = Arc::clone(&self.options.audit);
        let timeout_ms = self.options.timeout_ms;
        tokio::spawn(async move {
            let audit = audit(turn);
            let result = tokio::select! {
                outcome = run_until_idle(audit, heartbeat, timeout_ms) => Some(outcome),
                _ = stop.notified() => None,
            };
            if inner.stopping.load(Ordering::SeqCst) {
                return;
            }
            {
                let active = lock_unpoisoned(&inner.active);
                if active
                    .as_ref()
                    .map(|active| active.cycle_id != cycle_id)
                    .unwrap_or(true)
                {
                    return;
                }
            }
            match result {
                None => {}
                Some(Ok(())) => {
                    inner.complete_cycle(&cycle_id, &directory, &activity).await;
                }
                Some(Err(detail)) => inner.fail_cycle(&cycle_id, &detail),
            }
        });
        self.starting.store(false, Ordering::SeqCst);
    }

    fn audit_signal(
        self: &Arc<Self>,
        cycle_id: &str,
        heartbeat: Arc<CycleHeartbeat>,
    ) -> Arc<dyn Fn(AuditSignal) + Send + Sync> {
        let inner = Arc::clone(self);
        let cycle_id = cycle_id.to_string();
        Arc::new(move |signal| {
            let active_guard = lock_unpoisoned(&inner.active);
            let Some(active) = active_guard.as_ref() else {
                return;
            };
            if active.cycle_id != cycle_id || active.finished {
                return;
            }
            match signal {
                AuditSignal::Activity { text, append } => {
                    heartbeat.beat();
                    append_activity_line(&mut lock_unpoisoned(&active.activity), &text, append);
                    inner.write_activity_of(active);
                }
                AuditSignal::SessionUpdate => heartbeat.beat(),
                AuditSignal::Stderr(text) => {
                    let mut first = lock_unpoisoned(&active.first_line);
                    if first.is_none() {
                        let line = bounded_line(&text);
                        if !line.is_empty() {
                            *first = Some(line);
                        }
                    }
                }
            }
        })
    }

    fn write_activity_of(&self, active: &ActiveCycle) {
        write_activity(
            &active.directory,
            &lock_unpoisoned(&active.activity).clone(),
        );
    }

    fn record(&self, activity: &Arc<Mutex<Vec<String>>>, directory: &Path, line: &str) {
        append_activity_line(&mut lock_unpoisoned(activity), line, false);
        write_activity(directory, &lock_unpoisoned(activity).clone());
    }

    async fn complete_cycle(
        self: &Arc<Self>,
        cycle_id: &str,
        directory: &Path,
        activity: &Arc<Mutex<Vec<String>>>,
    ) {
        {
            let mut active = lock_unpoisoned(&self.active);
            if let Some(current) = active.as_mut() {
                if current.cycle_id != cycle_id {
                    return;
                }
                current.finished = true;
            }
        }
        let record = |line: &str| {
            self.record(activity, directory, line);
        };
        let mut error: Option<String> = None;
        let mut filed_now = 0usize;
        for entry in read_tool_log(&directory.join("tool-log.jsonl")) {
            let Some(object) = entry.as_object() else {
                continue;
            };
            if object.get("tool").and_then(Value::as_str) != Some("issue_create") {
                continue;
            }
            let ok = object.get("ok").and_then(Value::as_bool) == Some(true);
            let number = object
                .get("value")
                .and_then(|value| tool_value_number(value, "number"));
            let title = object
                .get("value")
                .and_then(|value| tool_value_string(value, "title"));
            if ok {
                if let (Some(number), Some(title)) = (number, title) {
                    filed_now += 1;
                    record(&format!("filed #{number} “{title}”"));
                    continue;
                }
            }
            let detail = object
                .get("error")
                .and_then(Value::as_str)
                .filter(|error| !error.is_empty())
                .unwrap_or("the issue-creation tool failed")
                .to_string();
            if error.is_none() {
                error = Some(detail.clone());
            }
            record(&format!("failed: {detail}"));
        }

        let request = read_release_request(directory);
        let documents = {
            let active = lock_unpoisoned(&self.active);
            active
                .as_ref()
                .filter(|active| active.cycle_id == cycle_id)
                .map(|active| active.documents.clone())
                .unwrap_or_default()
        };
        let changed = draft_changed(directory, &documents);
        let mut rejected: Option<String> = None;
        let mut release_error: Option<String> = None;
        if changed {
            match &request {
                None => record("ignored a document change without a release request"),
                Some(request) => {
                    let design_draft =
                        read_draft_document(directory, &self.options.config.design_document);
                    let token_draft =
                        read_draft_document(directory, &self.options.config.token_document);
                    let design_draft = design_draft.ok();
                    let token_draft = token_draft.ok();
                    if design_draft.is_none() || token_draft.is_none() {
                        let mut unreadable = Vec::new();
                        if design_draft.is_none() {
                            unreadable.push(self.options.config.design_document.clone());
                        }
                        if token_draft.is_none() {
                            unreadable.push(self.options.config.token_document.clone());
                        }
                        release_error = Some(format!(
                            "the revised {} could not be read from the draft",
                            unreadable.join(" and ")
                        ));
                    } else {
                        let design_text = design_draft.as_deref().unwrap_or("");
                        let token_text = token_draft.as_deref().unwrap_or("");
                        let missing = missing_principle_sections(design_text);
                        if !missing.is_empty() {
                            rejected = Some(format!(
                                "the revised {} lacks {}",
                                self.options.config.design_document,
                                missing.join(" and ")
                            ));
                        } else if !valid_token_document(token_text) {
                            rejected = Some(format!(
                                "the revised {} is not a JSON object",
                                self.options.config.token_document
                            ));
                        } else {
                            let original_tokens = documents
                                .iter()
                                .find(|document| {
                                    document.path == self.options.config.token_document
                                })
                                .map(|document| document.text.as_str())
                                .unwrap_or("");
                            let before = token_names(original_tokens);
                            let after = token_names(token_text);
                            let before_values = token_values(original_tokens);
                            let after_values = token_values(token_text);
                            let mut changed_tokens: Vec<String> = Vec::new();
                            let mut seen = HashSet::new();
                            for name in &after {
                                if !before.contains(name) && seen.insert(name.clone()) {
                                    changed_tokens.push(name.clone());
                                }
                            }
                            for (name, value) in &after_values {
                                let previous = before_values
                                    .iter()
                                    .find(|(candidate, _)| candidate == name)
                                    .map(|(_, value)| value.as_str());
                                if previous != Some(value.as_str()) && seen.insert(name.clone()) {
                                    changed_tokens.push(name.clone());
                                }
                            }
                            let undocked = tokens_named_in_prose(&changed_tokens, design_text);
                            if !undocked.is_empty() {
                                rejected = Some(format!(
                                    "the token document changes {} without a prose table entry",
                                    undocked.join(", ")
                                ));
                            }
                        }
                    }
                    if let Some(rejection) = &rejected {
                        record(&format!("documentation rejected: {rejection}"));
                    } else if release_error.is_none() {
                        if let (Some(design_text), Some(token_text)) =
                            (design_draft.as_deref(), token_draft.as_deref())
                        {
                            {
                                let mut state = lock_unpoisoned(&self.state);
                                state.lifecycle = DesignLifecycle::Releasing;
                            }
                            self.publish();
                            record(&format!("documentation: {}", request.summary));
                            let callback_activity = Arc::clone(activity);
                            let callback_directory = directory.to_path_buf();
                            let callback_signal = {
                                let inner = Arc::clone(self);
                                let directory = callback_directory.clone();
                                let activity = Arc::clone(&callback_activity);
                                Arc::new(move |line: &str| {
                                    inner.record(&activity, &directory, line);
                                })
                            };
                            let release_input = ReleaseInput {
                                repo_dir: self.options.repo_dir.clone(),
                                harness_dir: self.options.repo_dir.join(".devboard"),
                                cycle_id: cycle_id.to_string(),
                                summary: request.summary.clone(),
                                config: self.options.config.clone(),
                                documents: vec![
                                    ReleaseDocument {
                                        path: self.options.config.design_document.clone(),
                                        text: design_text.to_string(),
                                    },
                                    ReleaseDocument {
                                        path: self.options.config.token_document.clone(),
                                        text: token_text.to_string(),
                                    },
                                ],
                                environment: self.options.environment.clone(),
                                activity: callback_signal,
                            };
                            match (self.options.release)(release_input).await {
                                ReleaseResult::Ok(released) => {
                                    let at = iso_from_millis((self.options.clock)());
                                    let mut state = lock_unpoisoned(&self.state);
                                    state.release = Some(DesignStateRelease {
                                        version: released.version.clone(),
                                        url: released.url.clone(),
                                        at: at.clone(),
                                    });
                                    state.documentation = record_documentation_entry(
                                        &state.documentation,
                                        DesignDocumentationEntry {
                                            at,
                                            version: released.version.clone(),
                                            url: released.url.clone(),
                                            summary: request.summary.clone(),
                                            files: released.files.clone(),
                                            diff: released.diff.clone(),
                                        },
                                    );
                                    drop(state);
                                    record(&format!(
                                    "pushed documentation {}; the Release Train will release it",
                                    short_sha(&released.sha)
                                ));
                                }
                                ReleaseResult::Failed(failure) => {
                                    release_error = Some(failure.detail);
                                }
                            }
                        }
                    }
                    if let Some(detail) = &release_error {
                        record(&format!("documentation push failed: {detail}"));
                    }
                }
            }
        } else if request.is_some() {
            record("the release request produced no changed document");
        }

        let should_reread = {
            let state = lock_unpoisoned(&self.state);
            filed_now > 0 || !state.issues.is_empty()
        };
        if should_reread {
            match self.read_forge_within_deadline().await {
                Ok(read) => {
                    self.apply_read(read).await;
                    self.publish();
                }
                Err(detail) => record(&format!("could not re-read the forge: {detail}")),
            }
        }
        let error = release_error.or(error);
        self.finish_cycle(cycle_id, error);
    }

    fn fail_cycle(self: &Arc<Self>, cycle_id: &str, detail: &str) {
        let (first_line, activity, directory) = {
            let mut active = lock_unpoisoned(&self.active);
            match active.as_mut() {
                Some(current) if current.cycle_id == cycle_id => {
                    if current.finished {
                        return;
                    }
                    current.finished = true;
                    current.stop.notify_waiters();
                    let first = lock_unpoisoned(&current.first_line).clone();
                    let activity = Arc::clone(&current.activity);
                    let directory = current.directory.clone();
                    *active = None;
                    (first, activity, directory)
                }
                _ => return,
            }
        };
        let error = first_line.unwrap_or_else(|| detail_of(detail));
        self.record(&activity, &directory, &format!("failed: {error}"));
        self.cycle_running.store(false, Ordering::SeqCst);
        self.release_cycle_claim();
        self.signal_cycle_done();
        if self.stopping.load(Ordering::SeqCst) {
            return;
        }
        let now = (self.options.clock)();
        let mut state = lock_unpoisoned(&self.state);
        state.lifecycle = DesignLifecycle::Idle;
        state.last_error = Some(error.clone());
        state.notice = Some(format!("Audit failed: {error}"));
        state.next_attempt_at = Some(iso_from_millis(now + self.options.sync_ms as i64));
        drop(state);
        self.publish();
        if self.draining.load(Ordering::SeqCst) {
            self.spawn_stop();
        }
    }

    fn finish_cycle(self: &Arc<Self>, cycle_id: &str, error: Option<String>) {
        {
            let mut active = lock_unpoisoned(&self.active);
            if let Some(current) = active.as_ref() {
                if current.cycle_id != cycle_id {
                    return;
                }
            }
            *active = None;
        }
        self.cycle_running.store(false, Ordering::SeqCst);
        self.release_cycle_claim();
        self.signal_cycle_done();
        if self.stopping.load(Ordering::SeqCst) {
            return;
        }
        let now = (self.options.clock)();
        let cadence_at = self.cadence_ready_at(now);
        let cooldown_at = iso_from_millis(now + self.options.sync_ms as i64);
        let next_attempt_at = latest(cadence_at, Some(cooldown_at));
        let mut state = lock_unpoisoned(&self.state);
        state.lifecycle = DesignLifecycle::Idle;
        state.last_error = error.clone();
        if let Some(error) = &error {
            state.notice = Some(format!("Design cycle failed: {error}"));
        }
        state.next_attempt_at = next_attempt_at;
        drop(state);
        self.publish();
        if self.draining.load(Ordering::SeqCst) {
            self.spawn_stop();
        }
    }

    fn release_cycle_claim(&self) {
        *lock_unpoisoned(&self.cycle_claim) = None;
    }

    fn signal_cycle_done(&self) {
        if let Some(signal) = lock_unpoisoned(&self.cycle_signal).take() {
            signal.finish();
        }
    }

    fn spawn_stop(self: &Arc<Self>) {
        let inner = Arc::clone(self);
        tokio::spawn(async move {
            inner.stop().await;
        });
    }

    async fn stop(&self) {
        let existing = lock_unpoisoned(&self.stop_signal).clone();
        if let Some(signal) = existing {
            signal.wait().await;
            return;
        }
        let signal = Arc::new(CycleSignal::new());
        let raced = {
            let mut slot = lock_unpoisoned(&self.stop_signal);
            if slot.is_none() {
                *slot = Some(Arc::clone(&signal));
                None
            } else {
                slot.clone()
            }
        };
        if let Some(existing) = raced {
            existing.wait().await;
            return;
        }
        self.stopping.store(true, Ordering::SeqCst);
        {
            let mut active = lock_unpoisoned(&self.active);
            if let Some(mut current) = active.take() {
                current.finished = true;
                current.stop.notify_waiters();
                append_activity_line(&mut lock_unpoisoned(&current.activity), "stopped", false);
                write_activity(
                    &current.directory,
                    &lock_unpoisoned(&current.activity).clone(),
                );
            }
        }
        let releasing = lock_unpoisoned(&self.state).lifecycle == DesignLifecycle::Releasing;
        self.cycle_running.store(false, Ordering::SeqCst);
        self.release_cycle_claim();
        if releasing {
            let cycle = lock_unpoisoned(&self.cycle_signal).clone();
            if let Some(cycle) = cycle {
                cycle.wait().await;
            }
        } else {
            self.signal_cycle_done();
        }
        {
            let mut state = lock_unpoisoned(&self.state);
            state.enabled = false;
            state.lifecycle = DesignLifecycle::Stopped;
            state.next_attempt_at = None;
            state.last_error = None;
            state.notice = if self.draining.load(Ordering::SeqCst) {
                Some("Drained: exited after its in-flight cycle.".to_string())
            } else {
                None
            };
        }
        self.publish();
        if let Some(handle) = lock_unpoisoned(&self.ticker).take() {
            handle.abort();
        }
        *lock_unpoisoned(&self.lock) = None;
        self.stopped.notify_waiters();
        if let Some(callback) = &self.options.on_stopped {
            callback();
        }
        signal.finish();
    }
}

fn limit_label(value: Option<i64>) -> String {
    value
        .map(|amount| amount.to_string())
        .unwrap_or_else(|| "unlimited".to_string())
}

fn category_from_body(body: &str) -> Option<String> {
    let lines: Vec<&str> = body.split('\n').collect();
    let heading = lines
        .iter()
        .position(|line| line.trim().eq_ignore_ascii_case("## category"))?;
    for line in lines.iter().skip(heading + 1) {
        let value = line.trim();
        if value.is_empty() {
            continue;
        }
        if value.starts_with('#') {
            return None;
        }
        return if value.chars().count() <= 40 {
            Some(value.to_string())
        } else {
            None
        };
    }
    None
}

fn newest_first(rows: &mut [DesignIssueRow]) {
    rows.sort_by(|left, right| {
        let left_at = parse_iso_millis(&left.created_at);
        let right_at = parse_iso_millis(&right.created_at);
        match (left_at, right_at) {
            (Some(left_at), Some(right_at)) if left_at != right_at => right_at.cmp(&left_at),
            _ => right.number.cmp(&left.number),
        }
    });
}

fn latest(left: Option<String>, right: Option<String>) -> Option<String> {
    match (left, right) {
        (None, right) => right,
        (left, None) => left,
        (Some(left), Some(right)) => match (parse_iso_millis(&left), parse_iso_millis(&right)) {
            (Some(left_at), Some(right_at)) if left_at >= right_at => Some(left),
            _ => Some(right),
        },
    }
}

struct ForgeRead {
    issues: Vec<DesignForgeIssue>,
    releases: Vec<ForgeRelease>,
}

fn append_activity_line(lines: &mut Vec<String>, text: &str, append: bool) {
    if append && !lines.is_empty() {
        if let Some(last) = lines.last_mut() {
            last.push_str(text);
        }
    } else {
        lines.push(text.to_string());
    }
    trim_activity(lines);
}

fn trim_activity(lines: &mut Vec<String>) {
    const MAX_ENTRIES: usize = crate::state::ACTIVITY_MAX_ENTRIES;
    const MAX_BYTES: usize = crate::state::ACTIVITY_MAX_BYTES;
    let bytes: usize = lines.iter().map(|line| line.len()).sum();
    if lines.len() <= MAX_ENTRIES && bytes <= MAX_BYTES {
        return;
    }
    let marker = crate::state::ACTIVITY_TRIMMED_MARKER;
    let mut kept: Vec<String> = Vec::new();
    let mut kept_bytes = marker.len();
    for line in lines.iter().rev() {
        let entries = kept.len() + 2;
        if !kept.is_empty() && (entries > MAX_ENTRIES || kept_bytes + line.len() > MAX_BYTES) {
            break;
        }
        kept_bytes += line.len();
        kept.insert(0, line.clone());
    }
    lines.clear();
    lines.push(marker.to_string());
    lines.extend(kept);
}

fn write_activity(directory: &Path, lines: &[String]) {
    let _ = std::fs::create_dir_all(directory);
    let text = match serde_json::to_string(lines) {
        Ok(text) => text,
        Err(_) => return,
    };
    let _ = crate::state::write_file_atomically_sync(
        &directory.join("activity.json"),
        &format!("{text}\n"),
    );
}

fn read_tool_log(path: &Path) -> Vec<Value> {
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

fn tool_value_number(value: &Value, field: &str) -> Option<i64> {
    let amount = value.as_object()?.get(field)?.as_i64()?;
    (amount > 0).then_some(amount)
}

fn tool_value_string(value: &Value, field: &str) -> Option<String> {
    value.as_object()?.get(field)?.as_str().map(str::to_string)
}

/* ------------------------------------------------------------------------ */
/* Preflight                                                                 */
/* ------------------------------------------------------------------------ */

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DesignPreflightResult {
    Ok { repository: String },
    Refused { message: String },
}

#[derive(Debug, Clone)]
pub struct DesignPreflightOptions {
    pub repo_dir: PathBuf,
    pub state_dir: PathBuf,
    pub config: DesignConfig,
    pub environment: HashMap<String, String>,
    pub origin: Option<crate::forge::ForgeRemote>,
}

fn inside(root: &Path, candidate: &Path) -> bool {
    let relative = match resolve(candidate).strip_prefix(resolve(root)) {
        Ok(relative) => relative.to_path_buf(),
        Err(_) => return false,
    };
    !relative.as_os_str().is_empty()
        && !relative
            .components()
            .any(|component| matches!(component, Component::ParentDir))
}

fn preflight_refused(message: impl Into<String>) -> DesignPreflightResult {
    DesignPreflightResult::Refused {
        message: message.into(),
    }
}

async fn gh_preflight(
    argv: Vec<String>,
    environment: &HashMap<String, String>,
) -> (i32, String, String) {
    let mut command = tokio::process::Command::new("gh");
    command
        .args(&argv)
        .envs(environment)
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    match tokio::time::timeout(Duration::from_millis(20_000), command.output()).await {
        Ok(Ok(output)) => (
            output.status.code().unwrap_or(1),
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        ),
        Ok(Err(error)) => (1, String::new(), error.to_string()),
        Err(_) => (
            1,
            String::new(),
            "gh did not finish before its deadline".to_string(),
        ),
    }
}

/// Everything Start proves before it spawns the design worker.
pub async fn preflight_design(options: DesignPreflightOptions) -> DesignPreflightResult {
    let environment = options.environment;
    if let Some(problem) = crate::forge::root_problem(&options.repo_dir) {
        return preflight_refused(problem);
    }
    let root = resolve(&options.repo_dir);
    if !root.join(&options.config.source_dir).exists() {
        return preflight_refused(format!(
            "missing prerequisite: the canonical harness source checkout has no {} directory (an installed npm prefix is refused)",
            options.config.source_dir
        ));
    }
    let source = root.join(&options.config.source_dir);
    if !source.join("index.html").exists() && !source.join("..").join("index.html").exists() {
        return preflight_refused(format!(
            "missing prerequisite: {} has no index.html entry",
            options.config.source_dir
        ));
    }
    for document in [
        &options.config.design_document,
        &options.config.token_document,
    ] {
        if !root.join(document).exists() {
            return preflight_refused(format!("missing prerequisite: {document} is missing"));
        }
    }
    if !inside(&root, &options.state_dir) {
        return preflight_refused(format!(
            "STATE_DIR {} is not inside REPO_DIR {}; the design worker keeps its state beside the checkout",
            resolve(&options.state_dir).display(),
            root.display()
        ));
    }
    let remote = match options.origin {
        Some(remote) => remote,
        None => match crate::forge::origin_forge_with(&root, &environment) {
            Some(remote) => remote,
            None => {
                return preflight_refused(
                    "the checkout's origin does not name a supported repository",
                )
            }
        },
    };
    if remote.forge == crate::forge::Forge::GitLab {
        return preflight_refused(format!(
            "the design agent supports a GitHub or Gitea origin, not a GitLab one: {}",
            remote.host
        ));
    }
    for tool in ["git"] {
        if crate::forge::find_on_path(tool, &environment).is_none() {
            return preflight_refused(format!("missing prerequisite: {tool} is not on PATH"));
        }
    }
    if remote.forge == crate::forge::Forge::GitHub
        && crate::forge::find_on_path("gh", &environment).is_none()
    {
        return preflight_refused("missing prerequisite: gh is not on PATH");
    }
    if remote.forge == crate::forge::Forge::Gitea {
        let Some(base_url) = crate::forge::gitea_base_url(Some(&remote), &environment) else {
            return preflight_refused(
                "missing prerequisite: the Gitea address is not configured (set DEVBOARD_GITEA_URL or use an HTTP(S) origin)",
            );
        };
        if crate::forge::configured_gitea_token(&environment).is_none() {
            return preflight_refused("missing prerequisite: GITEA_TOKEN is not set");
        }
        let target = match crate::forge::gitea_target(
            Some(&remote),
            None,
            Some(&base_url),
            None,
            &environment,
        ) {
            Ok(target) => target,
            Err(error) => return preflight_refused(error.to_string()),
        };
        let transport = crate::forge::default_transport(20_000);
        let call = crate::forge::GiteaCallOptions {
            flow_id: None,
            timeout_ms: None,
        };
        let document = match crate::forge::gitea_repository(&target, &transport, &call).await {
            Ok(document) => document,
            Err(error) => {
                return preflight_refused(format!(
                    "missing prerequisite: the Gitea repository {} could not be read: {error}",
                    remote.project
                ))
            }
        };
        let permissions = document.permissions().cloned().unwrap_or(Value::Null);
        let writable = permissions
            .get("push")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || permissions
                .get("admin")
                .and_then(Value::as_bool)
                .unwrap_or(false);
        if !writable {
            return preflight_refused(format!(
                "missing prerequisite: the Gitea token cannot write to {} on {base_url}",
                remote.project
            ));
        }
        let labels = match crate::forge::gitea_labels(&target, &transport, &call).await {
            Ok(labels) => labels,
            Err(error) => {
                return preflight_refused(format!(
                    "missing prerequisite: the Gitea repository {} could not be read: {error}",
                    remote.project
                ))
            }
        };
        if !labels.iter().any(|label| label.name == DESIGN_LABEL) {
            if let Err(error) = crate::forge::gitea_create_label(
                &target,
                DESIGN_LABEL,
                LABEL_COLOR,
                LABEL_DESCRIPTION,
                &transport,
                &call,
            )
            .await
            {
                let after = crate::forge::gitea_labels(&target, &transport, &call)
                    .await
                    .unwrap_or_default();
                if !after.iter().any(|label| label.name == DESIGN_LABEL) {
                    return preflight_refused(format!(
                        "missing prerequisite: the \"{DESIGN_LABEL}\" label could not be created in {}: {error}",
                        remote.project
                    ));
                }
            }
        }
        return DesignPreflightResult::Ok {
            repository: remote.project,
        };
    }
    let permission = gh_preflight(
        vec![
            "api".to_string(),
            format!("repos/{}", remote.project),
            "--jq".to_string(),
            ".permissions.push".to_string(),
        ],
        &environment,
    )
    .await;
    if permission.0 != 0 || permission.1.trim() != "true" {
        let detail = if permission.2.trim().is_empty() {
            first_line(&permission.1)
        } else {
            first_line(&permission.2)
        };
        return preflight_refused(format!(
            "missing prerequisite: 'gh api repos/{} --jq .permissions.push' did not return true: {detail}",
            remote.project
        ));
    }
    let label = gh_preflight(
        vec![
            "api".to_string(),
            format!("repos/{}/labels/{DESIGN_LABEL}", remote.project),
            "--jq".to_string(),
            ".name".to_string(),
        ],
        &environment,
    )
    .await;
    if label.0 != 0 || label.1.trim() != DESIGN_LABEL {
        let created = gh_preflight(
            vec![
                "label".to_string(),
                "create".to_string(),
                DESIGN_LABEL.to_string(),
                "--repo".to_string(),
                remote.project.clone(),
                "--color".to_string(),
                LABEL_COLOR.to_string(),
                "--description".to_string(),
                LABEL_DESCRIPTION.to_string(),
                "--force".to_string(),
            ],
            &environment,
        )
        .await;
        if created.0 != 0 {
            return preflight_refused(format!(
                "missing prerequisite: the \"{DESIGN_LABEL}\" label could not be created in {}: {}",
                remote.project,
                first_line(&created.2)
            ));
        }
    }
    DesignPreflightResult::Ok {
        repository: remote.project,
    }
}

/* ------------------------------------------------------------------------ */
/* CLI                                                                       */
/* ------------------------------------------------------------------------ */

/// `devboard worker design --repo <checkout> --state-dir <dir> [--sync <ms>]`.
pub async fn run(invocation: &WorkerInvocation) -> anyhow::Result<()> {
    if invocation.repo_dir.as_os_str().is_empty() || invocation.state_dir.as_os_str().is_empty() {
        eprintln!(
            "usage: devboard worker design --repo <checkout> --state-dir <dir> [--sync <ms>]"
        );
        std::process::exit(2);
    }
    let repo_dir = resolve(&invocation.repo_dir);
    let state_dir = resolve(&invocation.state_dir);
    let environment = crate::forge::process_environment();
    let Some(repository) = crate::forge::origin_repository_with(&repo_dir, &environment) else {
        eprintln!("design worker: the checkout's origin does not name a repository");
        std::process::exit(2);
    };
    let harness_version = std::env::var("DEVBOARD_HARNESS_VERSION")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| crate::version::read_harness_version(&crate::version::running_harness_dir()));
    let sync_ms = invocation
        .option("sync")
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value >= 1_000)
        .or_else(|| {
            std::env::var("DESIGN_SYNC_MS")
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .filter(|value| *value >= 1_000)
        });
    let cadence_ms = std::env::var("DESIGN_CADENCE_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value >= 100);
    let mut options = DesignWorkerOptions::new(repo_dir, state_dir);
    options.agent_command = None;
    options.environment = environment;
    options.harness_version = harness_version;
    options.sync_ms = sync_ms;
    options.cadence_ms = cadence_ms;
    options.argv = invocation.raw.clone();
    options.log = Some(Arc::new(|line: &str| eprintln!("design: {line}")));
    let worker = DesignWorker::new(options);
    if !worker.start(&repository) {
        return Ok(());
    }
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        let mut interrupt =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        let signalled = tokio::select! {
            _ = worker.stopped() => None,
            _ = terminate.recv() => Some("SIGTERM"),
            _ = interrupt.recv() => Some("SIGINT"),
        };
        if let Some(signal) = signalled {
            eprintln!("design: received {signal}");
            worker.shutdown().await;
        }
    }
    #[cfg(not(unix))]
    {
        worker.stopped().await;
    }
    Ok(())
}
