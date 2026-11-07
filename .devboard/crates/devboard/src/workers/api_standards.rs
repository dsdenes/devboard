//! The detached API Standards worker.
//!
//! One worker per repository and harness version audits the HTTP surface the
//! dashboard server exposes against the project's REST skill, one cycle at a
//! time. It never edits the checkout and never files an issue itself: the
//! turn's only forge write is `issue_create`, and the worker records every
//! decision from the answer the peer writes.
//!
//! Durable surface: `<STATE_DIR>/api-standards/<repo key>/` carries the
//! versioned and legacy state, settings, and control channel; the checkout's
//! `.devboard/.tmp/api-standards/` carries the repository lock, the
//! cross-version cycle lease, and one directory per cycle.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::acp::{
    AcpActivity, AcpConnection, AcpConnectionOptions, AcpEvent, AcpQuestion, PermissionPolicy,
};
use crate::forge::{
    classify_forge_read_failure, Forge, ForgeReadFailureKind, ForgeReadRetry, ForgeRemote,
};
use crate::journal::journal_key;
use crate::providers::{
    create_worker_provider_environment, Env, ProviderOptions, WorkerProviderEnvironment,
};
use crate::version::read_harness_version;
use crate::workers::startup::{inherited_state_path, versioned_state_files};

use super::mcp_optimizer::{iso, now_iso};
use super::watchdog::{
    acquire_lock, claim_cycle, live_lock_owner, live_lock_owners, versioned_lock_path, ClaimHandle,
    LockDetails, LockHandle, LockResult,
};
use super::WorkerInvocation;

/* ------------------------------------------------------------------------ */
/* Constants and paths                                                       */
/* ------------------------------------------------------------------------ */

pub const API_STANDARDS_DIRECTORY: &str = "api-standards";
pub const STATE_VERSION: i64 = 1;
pub const CYCLE_VERSION: i64 = 1;
pub const SYNC_INTERVAL_MS: u64 = 60_000;
pub const HOUR_MS: i64 = 60 * 60_000;
pub const DEFAULT_MAX_PER_HOUR: Option<i64> = Some(10);
pub const DEFAULT_MAX_PENDING: Option<i64> = Some(5);
pub const DEFAULT_INTERVAL_MINUTES: i64 = 60;
pub const CADENCE_MIN_MINUTES: i64 = 1;
pub const CADENCE_MAX_MINUTES: i64 = 1440;
pub const LIMIT_MIN: i64 = 1;
pub const LIMIT_MAX: i64 = 100;
pub const CYCLE_ISSUE_LIMIT: i64 = 100;
pub const TITLE_MAX: usize = 200;

pub const API_STANDARDS_LABEL: &str = "api-standards";
pub const LABEL_COLOR: &str = "0e8a16";
pub const LABEL_DESCRIPTION: &str = "HTTP API deviation from the project REST standard";

pub const DEFAULT_API_SOURCE_DIRECTORY: &str = ".devboard/crates/devboard/src";
pub const DEFAULT_SKILL_DIRECTORY: &str = ".omp/skills/devboard-restful-api-implementation";
pub const SKILL_FILE: &str = "SKILL.md";
pub const RULES_FILE: &str = "references/zalando-rest-rules.md";

pub const TICK_MS: u64 = 100;
pub const DEFAULT_AGENT_COMMAND: &str = "omp acp";
pub const FIRST_LINE_MAX: usize = 400;
pub const READ_TIMEOUT_MS: u64 = 30_000;
pub const CYCLE_TIMEOUT_MS: u64 = 20 * 60_000;
pub const ACTIVITY_MAX_ENTRIES: usize = 1000;
pub const ACTIVITY_MAX_BYTES: usize = 1024 * 1024;
pub const ACTIVITY_TRIMMED_MARKER: &str = "Earlier activity was trimmed.";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    pub source_dir: String,
    pub skill_dir: String,
    pub skill_document: String,
    pub rules_document: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            source_dir: DEFAULT_API_SOURCE_DIRECTORY.to_string(),
            skill_dir: DEFAULT_SKILL_DIRECTORY.to_string(),
            skill_document: format!("{DEFAULT_SKILL_DIRECTORY}/{SKILL_FILE}"),
            rules_document: format!("{DEFAULT_SKILL_DIRECTORY}/{RULES_FILE}"),
        }
    }
}

/// The fixed audit configuration. No environment variable is added.
pub fn api_standards_config() -> Config {
    Config::default()
}

/// `<state-dir>/api-standards`.
pub fn api_standards_root(state_dir: &Path) -> PathBuf {
    state_dir.join(API_STANDARDS_DIRECTORY)
}

pub fn repo_state_directory(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    api_standards_root(state_dir).join(journal_key(&absolute(repo_dir)))
}

pub fn state_path(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    repo_state_directory(state_dir, repo_dir).join("state.json")
}

/// One worker version's state beside the legacy state older harnesses write.
pub fn versioned_state_path(state_dir: &Path, repo_dir: &Path, version: Option<&str>) -> PathBuf {
    repo_state_directory(state_dir, repo_dir)
        .join("workers")
        .join(worker_version_key(version))
        .join("state.json")
}

pub fn versioned_control_directory(
    state_dir: &Path,
    repo_dir: &Path,
    version: Option<&str>,
) -> PathBuf {
    repo_state_directory(state_dir, repo_dir)
        .join("workers")
        .join(worker_version_key(version))
        .join("control")
}

/// Every versioned worker directory under one repository state, sorted.
pub fn worker_state_directories(state_dir: &Path, repo_dir: &Path) -> Vec<PathBuf> {
    let root = repo_state_directory(state_dir, repo_dir).join("workers");
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut directories: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.path())
        .collect();
    directories.sort();
    directories
}

pub fn settings_path(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    repo_state_directory(state_dir, repo_dir).join("settings.json")
}

pub fn control_directory(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    repo_state_directory(state_dir, repo_dir).join("control")
}

/// `<REPO_DIR>/.devboard/.tmp/api-standards`, the checkout-anchored work tree.
pub fn work_directory(repo_dir: &Path) -> PathBuf {
    absolute(repo_dir)
        .join(".devboard")
        .join(".tmp")
        .join(API_STANDARDS_DIRECTORY)
}

/// The repository-anchored lock: one audit cycle per checkout.
pub fn lock_path(repo_dir: &Path) -> PathBuf {
    work_directory(repo_dir).join("lock")
}

pub fn cycles_directory(repo_dir: &Path) -> PathBuf {
    work_directory(repo_dir).join("cycles")
}

pub fn cycle_claim_path(repo_dir: &Path) -> PathBuf {
    work_directory(repo_dir).join("cycle-claim")
}

pub fn cycle_directory(repo_dir: &Path, cycle_id: &str) -> PathBuf {
    cycles_directory(repo_dir).join(cycle_id)
}

pub fn request_path(directory: &Path) -> PathBuf {
    directory.join("request.json")
}

pub fn findings_path(directory: &Path) -> PathBuf {
    directory.join("findings.json")
}

pub fn input_path(directory: &Path) -> PathBuf {
    directory.join("input.json")
}

pub fn activity_path(directory: &Path) -> PathBuf {
    directory.join("activity.json")
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

pub fn absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|directory| directory.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

/* ------------------------------------------------------------------------ */
/* Time and JSON                                                             */
/* ------------------------------------------------------------------------ */

pub fn clock_now(clock: &Clock) -> i64 {
    clock()
}

pub fn parse_iso_millis(text: &str) -> Option<i64> {
    super::mcp_optimizer::parse_instant_millis(text)
}

pub fn iso_from_millis(millis: i64) -> String {
    iso(super::mcp_optimizer::from_millis(millis))
}

pub fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

pub fn json_text(value: &Value) -> String {
    let mut text = serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".to_string());
    text.push('\n');
    text
}

pub fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
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

/* ------------------------------------------------------------------------ */
/* Published state                                                           */
/* ------------------------------------------------------------------------ */

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lifecycle {
    Stopped,
    Idle,
    Auditing,
    Failed,
}

impl Lifecycle {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::Idle => "idle",
            Self::Auditing => "auditing",
            Self::Failed => "failed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "stopped" => Some(Self::Stopped),
            "idle" => Some(Self::Idle),
            "auditing" => Some(Self::Auditing),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IssueState {
    Pending,
    Implemented,
}

impl IssueState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Implemented => "implemented",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(Self::Pending),
            "implemented" => Some(Self::Implemented),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncState {
    Ok,
    Error,
    Stale,
}

impl SyncState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Error => "error",
            Self::Stale => "stale",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "ok" => Some(Self::Ok),
            "error" => Some(Self::Error),
            "stale" => Some(Self::Stale),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkerRecord {
    pub pid: u32,
    pub started_at: String,
    pub state_dir: String,
    pub harness_version: Option<String>,
    pub argv: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Limits {
    pub max_per_hour: Option<i64>,
    pub max_pending: Option<i64>,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_per_hour: DEFAULT_MAX_PER_HOUR,
            max_pending: DEFAULT_MAX_PENDING,
        }
    }
}

impl Limits {
    pub fn to_json(&self) -> Value {
        json!({"maxPerHour": self.max_per_hour, "maxPending": self.max_pending})
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Settings {
    pub max_per_hour: Option<i64>,
    pub max_pending: Option<i64>,
    pub interval_minutes: i64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            max_per_hour: DEFAULT_MAX_PER_HOUR,
            max_pending: DEFAULT_MAX_PENDING,
            interval_minutes: DEFAULT_INTERVAL_MINUTES,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IssueRow {
    pub number: i64,
    pub title: String,
    pub url: String,
    pub created_at: String,
    pub state: IssueState,
    pub category: Option<String>,
    pub version: Option<String>,
}

impl IssueRow {
    pub fn to_json(&self) -> Value {
        json!({
            "number": self.number,
            "title": self.title,
            "url": self.url,
            "createdAt": self.created_at,
            "state": self.state.as_str(),
            "category": self.category,
            "version": self.version,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncStatus {
    pub state: SyncState,
    pub at: Option<String>,
    pub error: Option<String>,
}

impl SyncStatus {
    pub fn stale() -> Self {
        Self {
            state: SyncState::Stale,
            at: None,
            error: None,
        }
    }

    pub fn to_json(&self) -> Value {
        json!({"state": self.state.as_str(), "at": self.at, "error": self.error})
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct State {
    pub version: i64,
    pub repo: String,
    pub root: String,
    pub lifecycle: Lifecycle,
    pub enabled: bool,
    pub worker: Option<WorkerRecord>,
    pub limits: Limits,
    pub interval_minutes: i64,
    pub last_cycle_started_at: Option<String>,
    pub issues: Vec<IssueRow>,
    pub sync: SyncStatus,
    pub newest_cycle_id: Option<String>,
    pub next_attempt_at: Option<String>,
    pub last_error: Option<String>,
    pub notice: Option<String>,
    pub draining: bool,
    pub updated_at: String,
}

impl State {
    pub fn to_json(&self) -> Value {
        let worker = match &self.worker {
            Some(record) => json!({
                "pid": record.pid,
                "startedAt": record.started_at,
                "stateDir": record.state_dir,
                "harnessVersion": record.harness_version,
                "argv": record.argv,
            }),
            None => Value::Null,
        };
        json!({
            "version": self.version,
            "repo": self.repo,
            "root": self.root,
            "lifecycle": self.lifecycle.as_str(),
            "enabled": self.enabled,
            "worker": worker,
            "limits": self.limits.to_json(),
            "intervalMinutes": self.interval_minutes,
            "lastCycleStartedAt": self.last_cycle_started_at,
            "issues": self.issues.iter().map(IssueRow::to_json).collect::<Vec<_>>(),
            "sync": self.sync.to_json(),
            "newestCycleId": self.newest_cycle_id,
            "nextAttemptAt": self.next_attempt_at,
            "lastError": self.last_error,
            "notice": self.notice,
            "draining": self.draining,
            "updatedAt": self.updated_at,
        })
    }
}

pub struct EmptyStateOptions {
    pub repo: String,
    pub root: String,
    pub lifecycle: Lifecycle,
    pub limit: Limits,
    pub interval_minutes: i64,
    pub now: String,
}

impl Default for EmptyStateOptions {
    fn default() -> Self {
        Self {
            repo: String::new(),
            root: String::new(),
            lifecycle: Lifecycle::Stopped,
            limit: Limits::default(),
            interval_minutes: DEFAULT_INTERVAL_MINUTES,
            now: now_iso(),
        }
    }
}

pub fn empty_state(options: EmptyStateOptions) -> State {
    State {
        version: STATE_VERSION,
        repo: options.repo,
        root: options.root,
        lifecycle: options.lifecycle,
        enabled: false,
        worker: None,
        limits: options.limit,
        interval_minutes: options.interval_minutes,
        last_cycle_started_at: None,
        issues: Vec::new(),
        sync: SyncStatus::stale(),
        newest_cycle_id: None,
        next_attempt_at: None,
        last_error: None,
        notice: None,
        draining: false,
        updated_at: options.now,
    }
}

fn integer(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_i64)
}

fn nullable_string(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Null) | Some(Value::String(_)) | None)
}

pub fn is_valid_limit(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Null) => true,
        Some(Value::Number(number)) => number
            .as_i64()
            .is_some_and(|amount| (LIMIT_MIN..=LIMIT_MAX).contains(&amount)),
        _ => false,
    }
}

pub fn is_valid_cadence(value: Option<&Value>) -> bool {
    integer(value)
        .is_some_and(|amount| (CADENCE_MIN_MINUTES..=CADENCE_MAX_MINUTES).contains(&amount))
}

fn parse_limits(value: Option<&Value>) -> Option<Limits> {
    let record = value?.as_object()?;
    if !is_valid_limit(record.get("maxPerHour")) || !is_valid_limit(record.get("maxPending")) {
        return None;
    }
    Some(Limits {
        max_per_hour: record.get("maxPerHour").and_then(Value::as_i64),
        max_pending: record.get("maxPending").and_then(Value::as_i64),
    })
}

fn parse_issue_row(value: &Value) -> Option<IssueRow> {
    let record = value.as_object()?;
    let number = integer(record.get("number"))?;
    if number <= 0 {
        return None;
    }
    Some(IssueRow {
        number,
        title: record.get("title")?.as_str()?.to_string(),
        url: record.get("url")?.as_str()?.to_string(),
        created_at: record.get("createdAt")?.as_str()?.to_string(),
        state: IssueState::parse(record.get("state")?.as_str()?)?,
        category: record
            .get("category")
            .and_then(Value::as_str)
            .map(str::to_string),
        version: record
            .get("version")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn parse_sync(value: Option<&Value>) -> Option<SyncStatus> {
    let record = value?.as_object()?;
    if !nullable_string(record.get("at")) || !nullable_string(record.get("error")) {
        return None;
    }
    Some(SyncStatus {
        state: SyncState::parse(record.get("state")?.as_str()?)?,
        at: record.get("at").and_then(Value::as_str).map(str::to_string),
        error: record
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn parse_worker(value: &Value) -> Option<WorkerRecord> {
    let record = value.as_object()?;
    let pid = integer(record.get("pid"))?;
    if pid <= 0 {
        return None;
    }
    if !nullable_string(record.get("harnessVersion")) {
        return None;
    }
    let argv = record.get("argv")?.as_array()?;
    Some(WorkerRecord {
        pid: pid as u32,
        started_at: record.get("startedAt")?.as_str()?.to_string(),
        state_dir: record.get("stateDir")?.as_str()?.to_string(),
        harness_version: record
            .get("harnessVersion")
            .and_then(Value::as_str)
            .map(str::to_string),
        argv: argv
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
    })
}

pub fn parse_state(text: &str) -> Option<State> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    let record = parsed.as_object()?;
    if integer(record.get("version")) != Some(STATE_VERSION) {
        return None;
    }
    if !nullable_string(record.get("lastCycleStartedAt"))
        || !nullable_string(record.get("newestCycleId"))
        || !nullable_string(record.get("nextAttemptAt"))
        || !nullable_string(record.get("lastError"))
        || !nullable_string(record.get("notice"))
    {
        return None;
    }
    if record.get("draining").is_some() && record.get("draining").and_then(Value::as_bool).is_none()
    {
        return None;
    }
    let worker = match record.get("worker")? {
        Value::Null => None,
        other => Some(parse_worker(other)?),
    };
    let issues = record
        .get("issues")?
        .as_array()?
        .iter()
        .map(parse_issue_row)
        .collect::<Option<Vec<_>>>()?;
    Some(State {
        version: STATE_VERSION,
        repo: record.get("repo")?.as_str()?.to_string(),
        root: record.get("root")?.as_str()?.to_string(),
        lifecycle: Lifecycle::parse(record.get("lifecycle")?.as_str()?)?,
        enabled: record.get("enabled")?.as_bool()?,
        worker,
        limits: parse_limits(record.get("limits"))?,
        interval_minutes: integer(record.get("intervalMinutes"))?,
        last_cycle_started_at: record
            .get("lastCycleStartedAt")
            .and_then(Value::as_str)
            .map(str::to_string),
        issues,
        sync: parse_sync(record.get("sync"))?,
        newest_cycle_id: record
            .get("newestCycleId")
            .and_then(Value::as_str)
            .map(str::to_string),
        next_attempt_at: record
            .get("nextAttemptAt")
            .and_then(Value::as_str)
            .map(str::to_string),
        last_error: record
            .get("lastError")
            .and_then(Value::as_str)
            .map(str::to_string),
        notice: record
            .get("notice")
            .and_then(Value::as_str)
            .map(str::to_string),
        draining: record
            .get("draining")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        updated_at: record.get("updatedAt")?.as_str()?.to_string(),
    })
}

pub fn read_state(path: &Path) -> Option<State> {
    parse_state(&std::fs::read_to_string(path).ok()?)
}

/// Reads and moves an unusable file aside, preserved.
pub fn load_state(path: &Path) -> Option<State> {
    if !path.exists() {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    let state = parse_state(&text);
    if state.is_some() {
        return state;
    }
    quarantine(path);
    None
}

pub fn quarantine(path: &Path) -> Option<PathBuf> {
    let stamp = now_iso().replace([':', '.'], "-");
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
        if std::fs::rename(path, &target).is_ok() {
            return Some(target);
        }
        return None;
    }
    None
}

pub fn write_state(path: &Path, state: &State) -> std::io::Result<()> {
    write_atomic(path, &json_text(&state.to_json()))
}

pub fn read_settings(path: &Path) -> Option<Settings> {
    parse_settings(&std::fs::read_to_string(path).ok()?)
}

pub fn parse_settings(text: &str) -> Option<Settings> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    let record = parsed.as_object()?;
    let limits = parse_limits(Some(&parsed))?;
    let interval_minutes = match record.get("intervalMinutes") {
        None => DEFAULT_INTERVAL_MINUTES,
        Some(value) if is_valid_cadence(Some(value)) => value.as_i64()?,
        Some(_) => return None,
    };
    Some(Settings {
        max_per_hour: limits.max_per_hour,
        max_pending: limits.max_pending,
        interval_minutes,
    })
}

pub fn write_settings(path: &Path, settings: &Settings) -> std::io::Result<()> {
    write_atomic(
        path,
        &json_text(&json!({
            "maxPerHour": settings.max_per_hour,
            "maxPending": settings.max_pending,
            "intervalMinutes": settings.interval_minutes,
        })),
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Capacity {
    pub batch: i64,
    pub window_count: i64,
    pub open_count: i64,
    pub hourly_room: i64,
    pub pending_room: i64,
}

pub fn capacity_for(issues: &[IssueRow], limits: &Limits, now_millis: i64) -> Capacity {
    let window_start = now_millis - HOUR_MS;
    let mut window_count = 0_i64;
    let mut open_count = 0_i64;
    for issue in issues {
        if let Some(created) = parse_iso_millis(&issue.created_at) {
            if created > window_start {
                window_count += 1;
            }
        }
        if issue.state == IssueState::Pending {
            open_count += 1;
        }
    }
    let hourly_room = limits
        .max_per_hour
        .map(|limit| (limit - window_count).max(0))
        .unwrap_or(i64::MAX / 4);
    let pending_room = limits
        .max_pending
        .map(|limit| (limit - open_count).max(0))
        .unwrap_or(i64::MAX / 4);
    Capacity {
        batch: hourly_room.min(pending_room).min(CYCLE_ISSUE_LIMIT),
        window_count,
        open_count,
        hourly_room,
        pending_room,
    }
}

/// The `## Chapter` line of an api-standards issue body, for adopted rows.
pub fn category_from_body(body: &str) -> Option<String> {
    let lines: Vec<&str> = body.split('\n').collect();
    let heading = lines
        .iter()
        .position(|line| line.trim().eq_ignore_ascii_case("## chapter"))?;
    for line in lines.iter().skip(heading + 1) {
        let value = line.trim();
        if value.is_empty() {
            continue;
        }
        if value.starts_with('#') {
            return None;
        }
        return (value.chars().count() <= 200).then(|| value.to_string());
    }
    None
}

/* ------------------------------------------------------------------------ */
/* Control channel                                                           */
/* ------------------------------------------------------------------------ */

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
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

pub fn write_command(directory: &Path, command: &Command) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(directory)?;
    let sequence = COMMAND_SEQUENCE.fetch_add(1, Ordering::SeqCst) + 1;
    let millis = crate::forge::now_millis().max(0) as u128;
    let name = format!("{millis:014}-{sequence:06}.json");
    let path = directory.join(name);
    let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    write_atomic(
        &temporary,
        &format!(
            "{}\n",
            serde_json::to_string(&command_json(command)).unwrap_or_default()
        ),
    )?;
    std::fs::rename(&temporary, &path)?;
    Ok(path)
}

pub fn command_json(command: &Command) -> Value {
    match command {
        Command::Stop => json!({"type": "stop"}),
        Command::Drain => json!({"type": "drain"}),
        Command::Limits {
            max_per_hour,
            max_pending,
        } => json!({
            "type": "limits",
            "maxPerHour": max_per_hour,
            "maxPending": max_pending,
        }),
        Command::Cadence { interval_minutes } => {
            json!({"type": "cadence", "intervalMinutes": interval_minutes})
        }
        Command::Settings {
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

pub fn parse_command(text: &str) -> Option<Command> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    let record = parsed.as_object()?;
    match record.get("type")?.as_str()? {
        "stop" => Some(Command::Stop),
        "drain" => Some(Command::Drain),
        "limits" => {
            if !is_valid_limit(record.get("maxPerHour"))
                || !is_valid_limit(record.get("maxPending"))
            {
                return None;
            }
            Some(Command::Limits {
                max_per_hour: record.get("maxPerHour").and_then(Value::as_i64),
                max_pending: record.get("maxPending").and_then(Value::as_i64),
            })
        }
        "cadence" => {
            if !is_valid_cadence(record.get("intervalMinutes")) {
                return None;
            }
            Some(Command::Cadence {
                interval_minutes: record.get("intervalMinutes")?.as_i64()?,
            })
        }
        "settings" => {
            if !is_valid_cadence(record.get("intervalMinutes"))
                || !is_valid_limit(record.get("maxPerHour"))
                || !is_valid_limit(record.get("maxPending"))
            {
                return None;
            }
            Some(Command::Settings {
                interval_minutes: record.get("intervalMinutes")?.as_i64()?,
                max_per_hour: record.get("maxPerHour").and_then(Value::as_i64),
                max_pending: record.get("maxPending").and_then(Value::as_i64),
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
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
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

/* ------------------------------------------------------------------------ */
/* Activity                                                                  */
/* ------------------------------------------------------------------------ */

pub fn read_activity(directory: &Path) -> Vec<String> {
    read_json(&activity_path(directory))
        .and_then(|value| value.as_array().cloned())
        .map(|entries| {
            entries
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

pub fn write_activity(directory: &Path, lines: &[String]) -> std::io::Result<()> {
    let value = Value::Array(
        lines
            .iter()
            .map(|line| Value::String(line.clone()))
            .collect(),
    );
    write_atomic(
        &activity_path(directory),
        &format!("{}\n", serde_json::to_string(&value)?),
    )
}

pub fn trim_activity(lines: &mut Vec<String>) {
    let bytes: usize = lines.iter().map(|line| line.len()).sum();
    if lines.len() <= ACTIVITY_MAX_ENTRIES && bytes <= ACTIVITY_MAX_BYTES {
        return;
    }
    let marker_bytes = ACTIVITY_TRIMMED_MARKER.len();
    let mut kept: Vec<String> = Vec::new();
    let mut kept_bytes = marker_bytes;
    for line in lines.iter().rev() {
        let entries = kept.len() + 2;
        if !kept.is_empty()
            && (entries > ACTIVITY_MAX_ENTRIES || kept_bytes + line.len() > ACTIVITY_MAX_BYTES)
        {
            break;
        }
        kept_bytes += line.len();
        kept.push(line.clone());
    }
    kept.reverse();
    kept.insert(0, ACTIVITY_TRIMMED_MARKER.to_string());
    *lines = kept;
}

pub fn append_activity_line(lines: &mut Vec<String>, text: &str, append: bool) {
    if append {
        if let Some(last) = lines.last_mut() {
            last.push_str(text);
        } else {
            lines.push(text.to_string());
        }
    } else {
        lines.push(text.to_string());
    }
    trim_activity(lines);
}

/* ------------------------------------------------------------------------ */
/* Rules                                                                     */
/* ------------------------------------------------------------------------ */

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RestRule {
    pub id: String,
    pub level: String,
    pub chapter: String,
    pub directive: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RestSkill {
    pub skill_path: String,
    pub rules_path: String,
    pub skill_text: String,
    pub rules_text: String,
    pub rules: Vec<RestRule>,
    pub chapters: Vec<String>,
}

fn table_cells(line: &str) -> Option<Vec<String>> {
    let trimmed = line.trim();
    if !trimmed.starts_with('|') || !trimmed.ends_with('|') || trimmed.len() < 2 {
        return None;
    }
    Some(
        trimmed[1..trimmed.len() - 1]
            .split('|')
            .map(|cell| cell.trim().to_string())
            .collect(),
    )
}

pub fn parse_rules(text: &str, path: &str) -> Result<(Vec<RestRule>, Vec<String>), String> {
    let mut rules = Vec::new();
    let mut chapters = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut chapter: Option<String> = None;
    for line in text.split('\n') {
        if let Some(rest) = line.strip_prefix("## ") {
            let value = rest.trim();
            chapter = Some(value.to_string());
            if !value.is_empty() {
                chapters.push(value.to_string());
            }
            continue;
        }
        let Some(current) = &chapter else {
            continue;
        };
        let Some(cells) = table_cells(line) else {
            continue;
        };
        if cells.len() != 3 {
            continue;
        }
        let id = cells[0].clone();
        let level = cells[1].clone();
        let directive = cells[2].clone();
        if id.is_empty() || !id.chars().all(|character| character.is_ascii_digit()) {
            continue;
        }
        if !matches!(level.as_str(), "MUST" | "SHOULD" | "MAY") {
            continue;
        }
        if directive.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        rules.push(RestRule {
            id,
            level,
            chapter: current.clone(),
            directive,
        });
    }
    if rules.is_empty() {
        return Err(format!(
            "{path} has no rule table; the skill must list | <rule id> | <MUST|SHOULD|MAY> | \
             <directive> | rows under its chapter headings"
        ));
    }
    Ok((rules, chapters))
}

pub fn read_rest_skill(repo_dir: &Path, config: &Config) -> Result<RestSkill, String> {
    let root = absolute(repo_dir);
    let skill_path = config.skill_document.replace('\\', "/");
    let rules_path = config.rules_document.replace('\\', "/");
    let read = |relative: &str| -> Result<String, String> {
        std::fs::read_to_string(root.join(relative))
            .map_err(|_| format!("{relative} is not readable"))
    };
    let skill_text = read(&skill_path)?;
    if skill_text.trim().is_empty() {
        return Err(format!("{skill_path} is empty"));
    }
    let rules_text = read(&rules_path)?;
    let (rules, chapters) = parse_rules(&rules_text, &rules_path)?;
    Ok(RestSkill {
        skill_path,
        rules_path,
        skill_text,
        rules_text,
        rules,
        chapters,
    })
}

/* ------------------------------------------------------------------------ */
/* Audit input                                                               */
/* ------------------------------------------------------------------------ */

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuditFile {
    pub path: String,
    pub lines: usize,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RouteEntry {
    pub path: String,
    pub methods: Vec<String>,
    pub kind: String,
    pub source: String,
    pub line: usize,
}

impl RouteEntry {
    pub fn to_json(&self) -> Value {
        json!({
            "path": self.path,
            "methods": self.methods,
            "kind": self.kind,
            "source": self.source,
            "line": self.line,
        })
    }
}

#[derive(Clone, Debug)]
pub struct AuditInput {
    pub sources: Vec<AuditFile>,
    pub routes: Vec<RouteEntry>,
    pub skill: RestSkill,
    pub source_dir: String,
}

fn line_count(text: &str) -> usize {
    if text.is_empty() {
        0
    } else {
        text.strip_suffix('\n').unwrap_or(text).split('\n').count()
    }
}

/// A Rust file belongs to the dashboard's HTTP surface when it names axum's
/// request types or dispatches on the request path.
fn is_api_source(text: &str) -> bool {
    text.contains("axum::") || text.contains("HeaderMap") || text.contains("match uri.path()")
}

/// The audit walks the crate's Rust modules; `is_api_source` selects the
/// surface from their text.
fn walk_sources(directory: &Path, found: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    let mut children: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
    children.sort_by(|left, right| left.file_name().cmp(&right.file_name()));
    for child in children {
        let Some(name) = child.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let Ok(metadata) = std::fs::symlink_metadata(&child) else {
            continue;
        };
        if metadata.is_dir() {
            if name == "fixtures" || name == "node_modules" || name == "target" || name == "tests" {
                continue;
            }
            walk_sources(&child, found);
            continue;
        }
        if !metadata.is_file() || !name.ends_with(".rs") {
            continue;
        }
        found.push(child);
    }
}

/// One function definition inside an audited source.
#[derive(Clone, Copy, Debug)]
struct HandlerSpan {
    source: usize,
    start: usize,
    end: usize,
}

fn function_name(line: &str) -> Option<&str> {
    static FUNCTION: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"^\s*(?:pub )?(?:async )?fn ([a-z][a-z0-9_]*)\s*\(")
            .expect("a function pattern")
    });
    FUNCTION
        .captures(line)
        .and_then(|capture| capture.get(1))
        .map(|value| value.as_str())
}

fn handler_index(sources: &[AuditFile]) -> HashMap<String, HandlerSpan> {
    let mut handlers = HashMap::new();
    for (source, file) in sources.iter().enumerate() {
        let lines: Vec<&str> = file.text.split('\n').collect();
        let starts: Vec<usize> = lines
            .iter()
            .enumerate()
            .filter(|(_, line)| function_name(line).is_some())
            .map(|(index, _)| index)
            .collect();
        for (position, start) in starts.iter().enumerate() {
            let Some(name) = function_name(lines[*start]) else {
                continue;
            };
            let end = starts.get(position + 1).copied().unwrap_or(lines.len());
            handlers.entry(name.to_string()).or_insert(HandlerSpan {
                source,
                start: *start,
                end,
            });
        }
    }
    handlers
}

/// The methods a route answers, from its `Method::` comparisons and its
/// `Allow` headers.
fn methods_in(branch: &str) -> Vec<String> {
    static REQUEST_METHOD: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"Method::([A-Z]+)").expect("a request-method pattern")
    });
    static ALLOW_METHOD: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r#"\("Allow", "([A-Z]+)"\)"#).expect("an allow-header pattern")
    });
    let mut methods: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for capture in REQUEST_METHOD
        .captures_iter(branch)
        .chain(ALLOW_METHOD.captures_iter(branch))
    {
        if let Some(method) = capture.get(1) {
            let method = method.as_str().to_string();
            if seen.insert(method.clone()) {
                methods.push(method);
            }
        }
    }
    methods
}

/// The braces one line opens and closes, ignoring string literals and a
/// trailing line comment.
fn brace_delta(line: &str) -> (i32, i32) {
    let mut opens = 0i32;
    let mut closes = 0i32;
    let mut in_string = false;
    let mut escaped = false;
    let mut characters = line.chars().peekable();
    while let Some(character) = characters.next() {
        if in_string {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }
        match character {
            '"' => in_string = true,
            '/' if characters.peek() == Some(&'/') => break,
            '{' => opens += 1,
            '}' => closes += 1,
            _ => {}
        }
    }
    (opens, closes)
}

/// One `match uri.path()` block: the last line it covers and its arms.
fn dispatch_block(lines: &[&str], start: usize) -> Option<(usize, Vec<(usize, String)>)> {
    static ARM: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r#"^\s*"([^"]+)"\s*=>"#).expect("an arm pattern")
    });
    let mut depth = 0i32;
    let mut opened = false;
    let mut arms = Vec::new();
    for (index, line) in lines.iter().enumerate().skip(start) {
        if opened && depth == 1 && !line.trim_start().starts_with("//") {
            if let Some(capture) = ARM.captures(line) {
                if let Some(path) = capture.get(1) {
                    arms.push((index, path.as_str().to_string()));
                }
            }
        }
        let (opens, closes) = brace_delta(line);
        depth += opens - closes;
        if opens > 0 {
            opened = true;
        }
        if opened && depth <= 0 {
            return Some((index, arms));
        }
    }
    None
}

/// Each dispatcher arm: its line, its path, and the line its branch ends on.
fn dispatcher_arms(lines: &[&str]) -> Vec<(usize, String, usize)> {
    let mut routes = Vec::new();
    for (start, line) in lines.iter().enumerate() {
        if !line.contains("match uri.path()") {
            continue;
        }
        let Some((end, arms)) = dispatch_block(lines, start) else {
            continue;
        };
        for (position, (index, path)) in arms.iter().enumerate() {
            let stop = arms.get(position + 1).map(|(next, _)| *next).unwrap_or(end);
            routes.push((*index, path.clone(), stop));
        }
    }
    routes
}

/// Each `uri.path().strip_prefix("<prefix>")` route: its line, its path, and
/// the line its branch ends on.
fn prefix_routes(lines: &[&str]) -> Vec<(usize, String, usize)> {
    static PREFIX: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r#"uri\.path\(\)\.strip_prefix\("([^"]+)"\)"#)
            .expect("a prefix-route pattern")
    });
    let mut routes = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let Some(capture) = PREFIX.captures(line) else {
            continue;
        };
        let Some(prefix) = capture.get(1) else {
            continue;
        };
        let end = lines[index + 1..]
            .iter()
            .position(|line| function_name(line).is_some())
            .map(|offset| index + 1 + offset)
            .unwrap_or(lines.len())
            .min(index + 60);
        routes.push((index, format!("{}{{name}}", prefix.as_str()), end));
    }
    routes
}

/// The handler one route branch forwards to.
fn forwarded_handler(span: &str) -> Option<String> {
    static APP_CALL: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"\.app\s*\.\s*([a-z][a-z0-9_]*)\s*\(").expect("an app-call pattern")
    });
    static REPLY_CALL: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"reply\(\s*([a-z][a-z0-9_]*)\s*\(").expect("a reply-call pattern")
    });
    APP_CALL
        .captures(span)
        .or_else(|| REPLY_CALL.captures(span))
        .and_then(|capture| capture.get(1))
        .map(|value| value.as_str().to_string())
}

/// The route's own branch names its methods; an arm that forwards to a handler
/// takes them from that handler's body.
fn route_methods(
    span: &str,
    sources: &[AuditFile],
    handlers: &HashMap<String, HandlerSpan>,
) -> Vec<String> {
    let methods = methods_in(span);
    if !methods.is_empty() {
        return methods;
    }
    let Some(name) = forwarded_handler(span) else {
        return methods;
    };
    let Some(handler) = handlers.get(&name) else {
        return methods;
    };
    let lines: Vec<&str> = sources[handler.source].text.split('\n').collect();
    methods_in(&lines[handler.start..handler.end.min(lines.len())].join("\n"))
}

/// Every `match uri.path()` arm and every `uri.path().strip_prefix(...)` route
/// is one route; the branch body up to the next route names its methods.
pub fn route_inventory(sources: &[AuditFile]) -> Vec<RouteEntry> {
    let handlers = handler_index(sources);
    let mut routes = Vec::new();
    let mut serves_files = false;
    for source in sources {
        if source.text.contains("static_file(") {
            serves_files = true;
        }
        let lines: Vec<&str> = source.text.split('\n').collect();
        let mut found = dispatcher_arms(&lines);
        found.extend(prefix_routes(&lines));
        found.sort_by_key(|(start, _, _)| *start);
        for (start, path, end) in found {
            let span = lines[start..end.min(lines.len())].join("\n");
            let kind = if path == "/ws" { "upgrade" } else { "endpoint" };
            routes.push(RouteEntry {
                path,
                methods: route_methods(&span, sources, &handlers),
                kind: kind.to_string(),
                source: source.path.clone(),
                line: start + 1,
            });
        }
    }
    if serves_files {
        let methods = handlers
            .get("static_file")
            .map(|handler| {
                let lines: Vec<&str> = sources[handler.source].text.split('\n').collect();
                methods_in(&lines[handler.start..handler.end.min(lines.len())].join("\n"))
            })
            .filter(|methods| !methods.is_empty())
            .unwrap_or_else(|| vec!["GET".to_string(), "HEAD".to_string()]);
        routes.push(RouteEntry {
            path: "*".to_string(),
            methods,
            kind: "static-fallback".to_string(),
            source: sources
                .first()
                .map(|file| file.path.clone())
                .unwrap_or_default(),
            line: 1,
        });
    }
    routes.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then_with(|| left.source.cmp(&right.source))
    });
    routes
}

pub fn read_audit_input(repo_dir: &Path, config: &Config) -> Result<AuditInput, String> {
    let root = absolute(repo_dir);
    let source_root = root.join(&config.source_dir);
    let metadata = std::fs::symlink_metadata(&source_root).map_err(|_| {
        format!(
            "the canonical harness source checkout has no {} directory \
             (an installed npm prefix is refused)",
            config.source_dir
        )
    })?;
    if !metadata.is_dir() {
        return Err(format!("{} is not a directory", config.source_dir));
    }
    let mut files = Vec::new();
    walk_sources(&source_root, &mut files);
    let mut sources = Vec::new();
    for absolute_path in files {
        let relative = absolute_path
            .strip_prefix(&root)
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| absolute_path.to_string_lossy().into_owned());
        let text = std::fs::read_to_string(&absolute_path)
            .map_err(|_| format!("{relative} is not readable"))?;
        if !is_api_source(&text) {
            continue;
        }
        sources.push(AuditFile {
            path: relative,
            lines: line_count(&text),
            text,
        });
    }
    if sources.is_empty() {
        return Err(format!(
            "{} carries no API source file; a cycle cannot audit an empty surface",
            config.source_dir
        ));
    }
    let skill = read_rest_skill(&root, config)?;
    Ok(AuditInput {
        routes: route_inventory(&sources),
        sources,
        skill,
        source_dir: config.source_dir.clone(),
    })
}

/* ------------------------------------------------------------------------ */
/* One cycle's request and answer                                            */
/* ------------------------------------------------------------------------ */

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CycleRequest {
    pub version: i64,
    pub cycle_id: String,
    pub repository: String,
    pub repo_dir: String,
    pub source_dir: String,
    pub skill_document: String,
    pub rules_document: String,
    pub chapters: Vec<String>,
    pub rules: Vec<RestRule>,
    pub routes: Vec<RouteEntry>,
    pub sources: Vec<(String, usize)>,
    pub known_titles: Vec<String>,
    pub issue_room: i64,
    pub created_at: String,
}

impl CycleRequest {
    pub fn to_json(&self) -> Value {
        json!({
            "version": self.version,
            "cycleId": self.cycle_id,
            "repository": self.repository,
            "repoDir": self.repo_dir,
            "sourceDir": self.source_dir,
            "skillDocument": self.skill_document,
            "rulesDocument": self.rules_document,
            "chapters": self.chapters,
            "rules": self.rules.iter().map(|rule| json!({
                "id": rule.id,
                "level": rule.level,
                "chapter": rule.chapter,
            })).collect::<Vec<_>>(),
            "routes": self.routes.iter().map(RouteEntry::to_json).collect::<Vec<_>>(),
            "sources": self.sources.iter().map(|(path, lines)| json!({
                "path": path,
                "lines": lines,
            })).collect::<Vec<_>>(),
            "knownTitles": self.known_titles,
            "issueRoom": self.issue_room,
            "createdAt": self.created_at,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FindingEndpoint {
    pub method: String,
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FindingEvidence {
    pub path: String,
    pub lines: String,
    pub quote: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Finding {
    pub title: String,
    pub rule_id: String,
    pub level: String,
    pub chapter: String,
    pub directive: String,
    pub endpoints: Vec<FindingEndpoint>,
    pub evidence: Vec<FindingEvidence>,
    pub proposed_change: String,
    pub acceptance_criteria: Vec<String>,
    pub decision: String,
    pub reason: Option<String>,
    pub issue_number: Option<i64>,
    pub issue_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FindingsAnswer {
    pub findings: Vec<Finding>,
}

fn stamp(millis: i64) -> String {
    iso_from_millis(millis)
        .replace(['-', ':', '.'], "")
        .replace('T', "-")
        .replace('Z', "")
}

static CYCLE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn create_cycle_directory(
    repo_dir: &Path,
    now_millis: i64,
) -> Result<(String, PathBuf), String> {
    let base = format!("{}-{:06}", stamp(now_millis), std::process::id());
    for _attempt in 0..100 {
        let sequence = CYCLE_SEQUENCE.fetch_add(1, Ordering::SeqCst) + 1;
        let cycle_id = format!("{base}-{sequence:04}");
        let directory = cycle_directory(repo_dir, &cycle_id);
        if directory.exists() {
            continue;
        }
        std::fs::create_dir_all(&directory)
            .map_err(|error| format!("could not create {}: {error}", directory.display()))?;
        return Ok((cycle_id, directory));
    }
    Err("could not allocate a unique api-standards cycle directory".to_string())
}

pub struct WriteCycleOptions<'a> {
    pub cycle_id: &'a str,
    pub repository: &'a str,
    pub repo_dir: &'a Path,
    pub input: &'a AuditInput,
    pub config: &'a Config,
    pub known_titles: Vec<String>,
    pub issue_room: i64,
    pub now_millis: i64,
}

pub fn write_cycle(
    directory: &Path,
    options: WriteCycleOptions<'_>,
) -> std::io::Result<CycleRequest> {
    let mut known = options.known_titles;
    known.sort();
    let request = CycleRequest {
        version: CYCLE_VERSION,
        cycle_id: options.cycle_id.to_string(),
        repository: options.repository.to_string(),
        repo_dir: options.repo_dir.to_string_lossy().into_owned(),
        source_dir: options.config.source_dir.clone(),
        skill_document: options.input.skill.skill_path.clone(),
        rules_document: options.input.skill.rules_path.clone(),
        chapters: options.input.skill.chapters.clone(),
        rules: options.input.skill.rules.clone(),
        routes: options.input.routes.clone(),
        sources: options
            .input
            .sources
            .iter()
            .map(|file| (file.path.clone(), file.lines))
            .collect(),
        known_titles: known,
        issue_room: options.issue_room,
        created_at: iso_from_millis(options.now_millis),
    };
    let input = json!({
        "sources": options.input.sources.iter().map(|file| json!({
            "path": file.path,
            "lines": file.lines,
            "text": file.text,
        })).collect::<Vec<_>>(),
        "routes": options.input.routes.iter().map(RouteEntry::to_json).collect::<Vec<_>>(),
        "documents": [
            {"path": options.input.skill.skill_path, "text": options.input.skill.skill_text},
            {"path": options.input.skill.rules_path, "text": options.input.skill.rules_text},
        ],
    });
    write_atomic(&input_path(directory), &json_text(&input))?;
    write_atomic(&request_path(directory), &json_text(&request.to_json()))?;
    Ok(request)
}

pub fn prompt_for(directory: &Path) -> String {
    format!("/api-standards-audit {}", directory.display())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SkipReason {
    MayLevel,
    Duplicate,
    NoRoom,
    OutsideHttp,
    MissingCitation,
    MissingEvidence,
    ToolError,
}

impl SkipReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MayLevel => "may-level",
            Self::Duplicate => "duplicate",
            Self::NoRoom => "no-room",
            Self::OutsideHttp => "outside-http",
            Self::MissingCitation => "missing-citation",
            Self::MissingEvidence => "missing-evidence",
            Self::ToolError => "tool-error",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FindingProblem {
    Ok(RestRule),
    Problem { reason: SkipReason, detail: String },
}

pub struct FindingContext<'a> {
    pub rules: &'a [RestRule],
    pub sources: &'a HashMap<String, String>,
}

fn line_span(value: &str) -> Option<(usize, usize)> {
    let trimmed = value.trim();
    let (start_text, end_text) = match trimmed.split_once('-') {
        Some((start, end)) => (start, Some(end)),
        None => (trimmed, None),
    };
    if start_text.is_empty()
        || !start_text
            .chars()
            .all(|character| character.is_ascii_digit())
    {
        return None;
    }
    let start: usize = start_text.parse().ok()?;
    let end = match end_text {
        None => start,
        Some(text) => {
            if text.is_empty() || !text.chars().all(|character| character.is_ascii_digit()) {
                return None;
            }
            text.parse().ok()?
        }
    };
    (start >= 1 && end >= start).then_some((start, end))
}

fn evidence_json(entry: &FindingEvidence) -> Value {
    json!({"path": entry.path, "lines": entry.lines, "quote": entry.quote})
}

impl Finding {
    pub fn to_json(&self) -> Value {
        let mut record = Map::new();
        record.insert("title".into(), Value::String(self.title.clone()));
        record.insert("ruleId".into(), Value::String(self.rule_id.clone()));
        record.insert("level".into(), Value::String(self.level.clone()));
        record.insert("chapter".into(), Value::String(self.chapter.clone()));
        record.insert("directive".into(), Value::String(self.directive.clone()));
        record.insert(
            "endpoints".into(),
            Value::Array(
                self.endpoints
                    .iter()
                    .map(|endpoint| json!({"method": endpoint.method, "path": endpoint.path}))
                    .collect(),
            ),
        );
        record.insert(
            "evidence".into(),
            Value::Array(self.evidence.iter().map(evidence_json).collect()),
        );
        record.insert(
            "proposedChange".into(),
            Value::String(self.proposed_change.clone()),
        );
        record.insert(
            "acceptanceCriteria".into(),
            Value::Array(
                self.acceptance_criteria
                    .iter()
                    .map(|criterion| Value::String(criterion.clone()))
                    .collect(),
            ),
        );
        record.insert("decision".into(), Value::String(self.decision.clone()));
        if let Some(reason) = &self.reason {
            record.insert("reason".into(), Value::String(reason.clone()));
        }
        if let Some(number) = self.issue_number {
            record.insert("issueNumber".into(), Value::from(number));
        }
        if let Some(url) = &self.issue_url {
            record.insert("issueUrl".into(), Value::String(url.clone()));
        }
        Value::Object(record)
    }
}

/// Proves one candidate finding before its decision is recorded.
pub fn validate_finding(finding: &Value, context: &FindingContext<'_>) -> FindingProblem {
    let Some(record) = finding.as_object() else {
        return FindingProblem::Problem {
            reason: SkipReason::MissingCitation,
            detail: "the finding is not an object".to_string(),
        };
    };
    let title = record
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if title.is_empty() || title.chars().count() > TITLE_MAX {
        return FindingProblem::Problem {
            reason: SkipReason::MissingCitation,
            detail: format!("the title must be 1 through {TITLE_MAX} characters"),
        };
    }
    let rule_id = record
        .get("ruleId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let level = record
        .get("level")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if rule_id.is_empty()
        || !rule_id.chars().all(|character| character.is_ascii_digit())
        || !matches!(level, "MUST" | "SHOULD" | "MAY")
    {
        return FindingProblem::Problem {
            reason: SkipReason::MissingCitation,
            detail: "the finding cites no numeric rule id with its MUST, SHOULD, or MAY level"
                .to_string(),
        };
    }
    if level == "MAY" {
        return FindingProblem::Problem {
            reason: SkipReason::MayLevel,
            detail: format!("rule {rule_id} is MAY"),
        };
    }
    let Some(rule) = context
        .rules
        .iter()
        .find(|entry| entry.id == rule_id && entry.level == level)
    else {
        return FindingProblem::Problem {
            reason: SkipReason::MissingCitation,
            detail: format!("the skill publishes no rule {rule_id} at level {level}"),
        };
    };
    if record.get("chapter").and_then(Value::as_str) != Some(rule.chapter.as_str()) {
        return FindingProblem::Problem {
            reason: SkipReason::MissingCitation,
            detail: format!(
                "rule {rule_id} sits under {}, not {}",
                rule.chapter,
                record.get("chapter").and_then(Value::as_str).unwrap_or("")
            ),
        };
    }
    if record.get("directive").and_then(Value::as_str) != Some(rule.directive.as_str()) {
        return FindingProblem::Problem {
            reason: SkipReason::MissingCitation,
            detail: format!(
                "the quoted directive for rule {rule_id} is not the skill's verbatim directive"
            ),
        };
    }
    let endpoints = record.get("endpoints").and_then(Value::as_array);
    let Some(endpoints) = endpoints.filter(|entries| !entries.is_empty()) else {
        return FindingProblem::Problem {
            reason: SkipReason::OutsideHttp,
            detail: "the finding names no HTTP endpoint".to_string(),
        };
    };
    for endpoint in endpoints {
        let Some(endpoint) = endpoint.as_object() else {
            return FindingProblem::Problem {
                reason: SkipReason::OutsideHttp,
                detail: "an endpoint is not an object".to_string(),
            };
        };
        let method = endpoint.get("method").and_then(Value::as_str).unwrap_or("");
        if method.is_empty()
            || !method
                .chars()
                .all(|character| character.is_ascii_uppercase() || character == '*')
        {
            return FindingProblem::Problem {
                reason: SkipReason::OutsideHttp,
                detail: "an endpoint names no HTTP method".to_string(),
            };
        }
        let path = endpoint.get("path").and_then(Value::as_str).unwrap_or("");
        if !path.starts_with('/') {
            return FindingProblem::Problem {
                reason: SkipReason::OutsideHttp,
                detail: "an endpoint names no request path".to_string(),
            };
        }
    }
    let evidence = record.get("evidence").and_then(Value::as_array);
    let Some(evidence) = evidence.filter(|entries| !entries.is_empty()) else {
        return FindingProblem::Problem {
            reason: SkipReason::MissingEvidence,
            detail: "the finding carries no evidence".to_string(),
        };
    };
    for entry in evidence {
        let Some(item) = entry.as_object() else {
            return FindingProblem::Problem {
                reason: SkipReason::MissingEvidence,
                detail: "an evidence entry is not an object".to_string(),
            };
        };
        let path = item.get("path").and_then(Value::as_str).unwrap_or("");
        let Some(text) = context.sources.get(path) else {
            return FindingProblem::Problem {
                reason: SkipReason::MissingEvidence,
                detail: format!(
                    "{} is not an audited source file",
                    if path.is_empty() {
                        "an evidence entry"
                    } else {
                        path
                    }
                ),
            };
        };
        let Some(span) = item
            .get("lines")
            .and_then(Value::as_str)
            .and_then(line_span)
        else {
            return FindingProblem::Problem {
                reason: SkipReason::MissingEvidence,
                detail: format!("{path} names no line range"),
            };
        };
        let quote = item
            .get("quote")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if quote.is_empty() {
            return FindingProblem::Problem {
                reason: SkipReason::MissingEvidence,
                detail: format!("{path} carries an empty quote"),
            };
        }
        let lines: Vec<&str> = text.split('\n').collect();
        let (start, end) = span;
        if end > lines.len() {
            return FindingProblem::Problem {
                reason: SkipReason::MissingEvidence,
                detail: format!("{path}:{start}-{end} runs past the file"),
            };
        }
        if !lines[start - 1..end].join("\n").contains(quote) {
            return FindingProblem::Problem {
                reason: SkipReason::MissingEvidence,
                detail: format!("the quote at {path}:{start}-{end} is not copied from those lines"),
            };
        }
    }
    let proposed = record
        .get("proposedChange")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if proposed.is_empty() {
        return FindingProblem::Problem {
            reason: SkipReason::MissingCitation,
            detail: "the finding carries no proposed change".to_string(),
        };
    }
    let criteria = record.get("acceptanceCriteria").and_then(Value::as_array);
    let valid = criteria.is_some_and(|entries| {
        !entries.is_empty()
            && entries.iter().all(|entry| {
                entry
                    .as_str()
                    .map(|text| !text.trim().is_empty())
                    .unwrap_or(false)
            })
    });
    if !valid {
        return FindingProblem::Problem {
            reason: SkipReason::MissingCitation,
            detail: "the finding carries no acceptance criteria".to_string(),
        };
    }
    FindingProblem::Ok(rule.clone())
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn endpoints_of(value: Option<&Value>) -> Vec<FindingEndpoint> {
    value
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let record = entry.as_object()?;
                    Some(FindingEndpoint {
                        method: record.get("method")?.as_str()?.to_string(),
                        path: record.get("path")?.as_str()?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn evidence_of(value: Option<&Value>) -> Vec<FindingEvidence> {
    value
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let record = entry.as_object()?;
                    Some(FindingEvidence {
                        path: record.get("path")?.as_str()?.to_string(),
                        lines: record.get("lines")?.as_str()?.to_string(),
                        quote: record.get("quote")?.as_str()?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Reads the answer the peer wrote. A missing or malformed answer has none.
pub fn read_findings(directory: &Path) -> Option<FindingsAnswer> {
    let parsed = read_json(&findings_path(directory))?;
    let record = parsed.as_object()?;
    if integer(record.get("version")) != Some(1) {
        return None;
    }
    let entries = record.get("findings")?.as_array()?;
    let mut findings = Vec::new();
    for entry in entries {
        let Some(candidate) = entry.as_object() else {
            continue;
        };
        let decision = candidate.get("decision").and_then(Value::as_str)?;
        if decision != "filed" && decision != "skipped" {
            continue;
        }
        findings.push(Finding {
            title: candidate
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            rule_id: candidate
                .get("ruleId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            level: candidate
                .get("level")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            chapter: candidate
                .get("chapter")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            directive: candidate
                .get("directive")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            endpoints: endpoints_of(candidate.get("endpoints")),
            evidence: evidence_of(candidate.get("evidence")),
            proposed_change: candidate
                .get("proposedChange")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            acceptance_criteria: string_array(candidate.get("acceptanceCriteria")),
            decision: decision.to_string(),
            reason: candidate
                .get("reason")
                .and_then(Value::as_str)
                .map(str::to_string),
            issue_number: integer(candidate.get("issueNumber")),
            issue_url: candidate
                .get("issueUrl")
                .and_then(Value::as_str)
                .map(str::to_string),
        });
    }
    Some(FindingsAnswer { findings })
}

/* ------------------------------------------------------------------------ */
/* Forge seam                                                                */
/* ------------------------------------------------------------------------ */

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForgeIssue {
    pub number: i64,
    pub title: String,
    pub url: String,
    /// `"open"` or `"closed"`.
    pub state: String,
    pub created_at: String,
    pub body: String,
    pub labels: Vec<String>,
}

pub type ForgeFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;

/// The forge facts one API Standards read needs.
pub trait ForgeClient: Send + Sync {
    fn list_issues(&self) -> ForgeFuture<'_, Vec<ForgeIssue>>;
    fn list_open_issue_titles(&self) -> ForgeFuture<'_, Vec<String>>;
}

#[derive(Clone)]
struct RealForge {
    client: Arc<crate::forge::ForgeIssuesClient>,
}

impl RealForge {
    fn new(repo_dir: &Path) -> Result<Self, String> {
        let options = crate::forge::ForgeIssuesOptions::new(repo_dir);
        let client =
            crate::forge::ForgeIssuesClient::new(options).map_err(|error| error.message)?;
        Ok(Self {
            client: Arc::new(client),
        })
    }
}

impl ForgeClient for RealForge {
    fn list_issues(&self) -> ForgeFuture<'_, Vec<ForgeIssue>> {
        let client = Arc::clone(&self.client);
        Box::pin(async move {
            let documents = client
                .list_labelled(crate::forge::IssueQueryState::All, API_STANDARDS_LABEL)
                .await
                .map_err(|error| error.message)?;
            let mut issues = Vec::new();
            for document in documents {
                issues.push(ForgeIssue {
                    number: document.number,
                    title: document.title,
                    url: document.url,
                    state: match document.state {
                        crate::forge::IssueState::Closed => "closed".to_string(),
                        crate::forge::IssueState::Open => "open".to_string(),
                    },
                    created_at: document.created_at.unwrap_or_default(),
                    body: document.body,
                    labels: document.labels,
                });
            }
            Ok(issues)
        })
    }

    fn list_open_issue_titles(&self) -> ForgeFuture<'_, Vec<String>> {
        let client = Arc::clone(&self.client);
        Box::pin(async move {
            let rows = client
                .list(crate::forge::IssueQueryState::Open, Some(1000))
                .await
                .map_err(|error| error.message)?;
            Ok(rows.into_iter().map(|row| row.title).collect())
        })
    }
}

/// The production forge client for one checkout.
pub fn create_forge(repo_dir: &Path) -> Result<Arc<dyn ForgeClient>, String> {
    Ok(Arc::new(RealForge::new(repo_dir)?))
}

/* ------------------------------------------------------------------------ */
/* Peer seam                                                                 */
/* ------------------------------------------------------------------------ */

#[derive(Clone, Default)]
pub struct PeerCallbacks {
    pub on_activity: Option<Arc<dyn Fn(AcpActivity) + Send + Sync>>,
    pub on_stderr: Option<Arc<dyn Fn(String) + Send + Sync>>,
    pub on_session_update: Option<Arc<dyn Fn() + Send + Sync>>,
}

pub struct PeerOptions {
    pub command: String,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
    pub callbacks: PeerCallbacks,
}

pub type PeerRunFuture<'a> = Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>>;

/// One agent session. The cycle closes it on every terminal path.
pub trait Peer: Send + Sync {
    fn run(&self, prompt: String) -> PeerRunFuture<'_>;
    fn close(&self);
}

/// The progress beat one audit cycle shares between its peer callbacks and the
/// idle deadline that ends it. A cycle that keeps emitting activity or session
/// updates stays alive past the deadline; a peer that has emitted nothing for
/// the whole deadline fails the cycle.
pub struct CycleHeartbeat {
    last: Mutex<std::time::Instant>,
}

impl CycleHeartbeat {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            last: Mutex::new(std::time::Instant::now()),
        })
    }

    pub fn beat(&self) {
        if let Ok(mut last) = self.last.lock() {
            *last = std::time::Instant::now();
        }
    }

    pub fn idle(&self) -> Duration {
        self.last
            .lock()
            .map(|last| last.elapsed())
            .unwrap_or_default()
    }
}

/// Runs one turn until it finishes or stays silent for `timeout_ms`. Any
/// activity or session update recorded on the shared heartbeat restarts the
/// window, so a long turn that keeps reporting progress is never killed for
/// taking long.
pub async fn run_until_idle(
    run: impl Future<Output = Result<(), String>>,
    heartbeat: Arc<CycleHeartbeat>,
    timeout_ms: u64,
) -> Result<(), String> {
    let run = run;
    tokio::pin!(run);
    let poll = Duration::from_millis((timeout_ms / 8).clamp(10, 5_000));
    let deadline = Duration::from_millis(timeout_ms.max(1));
    loop {
        tokio::select! {
            outcome = &mut run => return outcome,
            _ = tokio::time::sleep(poll) => {
                if heartbeat.idle() >= deadline {
                    return Err("the cycle timed out".to_string());
                }
            }
        }
    }
}

/// Runs one peer until it finishes or stays silent for `timeout_ms`.
pub async fn run_peer_until_idle(
    peer: Arc<dyn Peer>,
    prompt: String,
    heartbeat: Arc<CycleHeartbeat>,
    timeout_ms: u64,
) -> Result<(), String> {
    run_until_idle(peer.run(prompt), heartbeat, timeout_ms).await
}

pub type PeerConnectFuture = Pin<Box<dyn Future<Output = Result<Arc<dyn Peer>, String>> + Send>>;
pub type ConnectFn = Arc<dyn Fn(PeerOptions) -> PeerConnectFuture + Send + Sync>;

struct AcpPeer {
    connection: Arc<AcpConnection>,
}

impl Peer for AcpPeer {
    fn run(&self, prompt: String) -> PeerRunFuture<'_> {
        let connection = Arc::clone(&self.connection);
        Box::pin(async move {
            connection
                .run(&prompt)
                .await
                .map(|_| ())
                .map_err(|error| error.to_string())
        })
    }

    fn close(&self) {
        self.connection.close();
    }
}

/// The production connection: one ACP peer with its event pump.
pub fn default_connect(options: PeerOptions) -> PeerConnectFuture {
    Box::pin(async move {
        let connection_options = AcpConnectionOptions::new(
            options.command.clone(),
            options.cwd.to_string_lossy().into_owned(),
        )
        .with_starter("API Standards")
        .with_env(options.env.clone())
        .with_permission_policy(PermissionPolicy::Allow);
        let (connection, mut events) = AcpConnection::connect(connection_options)
            .await
            .map_err(|error| error.message)?;
        let connection = Arc::new(connection);
        let pump = Arc::clone(&connection);
        let callbacks = options.callbacks;
        tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                match event {
                    AcpEvent::Activity(activity) => {
                        if let Some(callback) = &callbacks.on_activity {
                            callback(activity);
                        }
                    }
                    AcpEvent::Question(question) => {
                        answer_question(&pump, &callbacks, &question).await;
                    }
                    AcpEvent::Stderr(text) => {
                        if let Some(callback) = &callbacks.on_stderr {
                            callback(text);
                        }
                    }
                    AcpEvent::SessionUpdate => {
                        if let Some(callback) = &callbacks.on_session_update {
                            callback();
                        }
                    }
                    AcpEvent::Text(_) => {}
                }
            }
        });
        Ok(Arc::new(AcpPeer { connection }) as Arc<dyn Peer>)
    })
}

async fn answer_question(
    connection: &AcpConnection,
    callbacks: &PeerCallbacks,
    question: &AcpQuestion,
) {
    let record = |text: String| {
        if let Some(callback) = &callbacks.on_activity {
            callback(AcpActivity {
                text,
                append: false,
            });
        }
    };
    record(format!("question: {}", question.message));
    let option = question
        .options
        .iter()
        .find(|option| option.recommended)
        .or_else(|| question.options.first());
    let value = option
        .map(|option| option.label.clone())
        .unwrap_or_default();
    let answered = connection.answer(&question.id, &value).await;
    record(format!(
        "answer: {}",
        if !answered {
            "failed".to_string()
        } else if value.is_empty() {
            "(no options offered)".to_string()
        } else {
            value
        }
    ));
}

/* ------------------------------------------------------------------------ */
/* The worker                                                                */
/* ------------------------------------------------------------------------ */

pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

struct ActiveCycle {
    cycle_id: String,
    directory: PathBuf,
    activity: Vec<String>,
    peer: Arc<dyn Peer>,
    heartbeat: Arc<CycleHeartbeat>,
    first_line: Option<String>,
    finished: bool,
    input: AuditInput,
}

struct Inner {
    state: State,
    forge: Option<Arc<dyn ForgeClient>>,
    open_titles: Vec<String>,
    active: Option<ActiveCycle>,
    starting: bool,
    stopping: bool,
    consuming: bool,
    syncing: bool,
    cycling: bool,
    draining: bool,
    retry: ForgeReadRetry,
    next_sync_at: i64,
    lock: Option<LockHandle>,
    cycle_claim: Option<ClaimHandle>,
    last_saved: String,
}

pub struct WorkerOptions {
    pub repo_dir: PathBuf,
    pub state_dir: PathBuf,
    pub agent_command: Option<String>,
    pub environment: HashMap<String, String>,
    pub sync_ms: Option<u64>,
    pub cadence_ms: Option<u64>,
    pub tick_ms: Option<u64>,
    pub read_timeout_ms: Option<u64>,
    pub timeout_ms: Option<u64>,
    pub clock: Option<Clock>,
    pub connect: Option<ConnectFn>,
    pub forge: Option<Arc<dyn ForgeClient>>,
    pub harness_version: Option<String>,
    pub config: Option<Config>,
    pub manual_cycles: bool,
    pub provider_environment: Option<Arc<WorkerProviderEnvironment>>,
    pub log: Option<Arc<dyn Fn(String) + Send + Sync>>,
}

impl WorkerOptions {
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
            clock: None,
            connect: None,
            forge: None,
            harness_version: None,
            config: None,
            manual_cycles: false,
            provider_environment: None,
            log: None,
        }
    }
}

pub struct Worker {
    repo_dir: PathBuf,
    state_dir: PathBuf,
    sync_ms: u64,
    cadence_override_ms: Option<u64>,
    tick_ms: u64,
    read_timeout_ms: u64,
    timeout_ms: u64,
    agent_command: String,
    clock: Clock,
    connect: ConnectFn,
    provider_environment: Arc<WorkerProviderEnvironment>,
    harness_version: Option<String>,
    config: Config,
    manual_cycles: bool,
    log: Arc<dyn Fn(String) + Send + Sync>,
    inner: Mutex<Inner>,
    settled: tokio::sync::Notify,
    weak: std::sync::Weak<Worker>,
}

impl Worker {
    pub fn new(options: WorkerOptions) -> Arc<Self> {
        let repo_dir = absolute(&options.repo_dir);
        let state_dir = absolute(&options.state_dir);
        let now: Clock = options
            .clock
            .unwrap_or_else(|| Arc::new(crate::forge::now_millis));
        let environment = options.environment.clone();
        let provider_environment = options.provider_environment.unwrap_or_else(|| {
            let env: Env = environment
                .iter()
                .map(|(key, value)| (key.clone(), Some(value.clone())))
                .collect();
            Arc::new(create_worker_provider_environment(
                &state_dir,
                &repo_dir,
                env,
                ProviderOptions::default(),
            ))
        });
        let agent_command = options
            .agent_command
            .or_else(|| environment.get("AGENT_COMMAND").cloned())
            .unwrap_or_else(|| DEFAULT_AGENT_COMMAND.to_string());
        let initial = empty_state(EmptyStateOptions {
            root: repo_dir.to_string_lossy().into_owned(),
            now: iso_from_millis(now()),
            ..EmptyStateOptions::default()
        });
        Arc::new_cyclic(|weak| Self {
            repo_dir,
            state_dir,
            sync_ms: options.sync_ms.unwrap_or(SYNC_INTERVAL_MS).max(1000),
            cadence_override_ms: options.cadence_ms,
            tick_ms: options.tick_ms.unwrap_or(TICK_MS).max(1),
            read_timeout_ms: options.read_timeout_ms.unwrap_or(READ_TIMEOUT_MS).max(1),
            timeout_ms: options.timeout_ms.unwrap_or(CYCLE_TIMEOUT_MS).max(1000),
            agent_command,
            clock: now,
            connect: options.connect.unwrap_or_else(|| Arc::new(default_connect)),
            provider_environment,
            harness_version: options.harness_version,
            config: options.config.unwrap_or_default(),
            manual_cycles: options.manual_cycles,
            log: options.log.unwrap_or_else(|| Arc::new(|_line| {})),
            inner: Mutex::new(Inner {
                state: initial,
                forge: options.forge,
                open_titles: Vec::new(),
                active: None,
                starting: false,
                stopping: false,
                consuming: false,
                syncing: false,
                cycling: false,
                draining: false,
                retry: ForgeReadRetry::new(),
                next_sync_at: 0,
                lock: None,
                cycle_claim: None,
                last_saved: String::new(),
            }),
            settled: tokio::sync::Notify::new(),
            weak: weak.clone(),
        })
    }

    pub fn repo_dir(&self) -> &Path {
        &self.repo_dir
    }

    pub fn state_dir(&self) -> &Path {
        &self.state_dir
    }

    pub fn tick_ms(&self) -> u64 {
        self.tick_ms
    }

    pub fn current_state(&self) -> State {
        lock(&self.inner).state.clone()
    }

    pub fn cycling_now(&self) -> bool {
        lock(&self.inner).cycling
    }

    pub fn is_stopped(&self) -> bool {
        let inner = lock(&self.inner);
        inner.stopping || !inner.state.enabled
    }

    /// True when no cycle is starting, running, or settling.
    pub fn is_settled(&self) -> bool {
        let inner = lock(&self.inner);
        !inner.starting && !inner.cycling && inner.active.is_none()
    }

    /// The bound one cycle may take before its peer is closed.
    pub fn cycle_timeout_ms(&self) -> u64 {
        self.timeout_ms
    }

    fn now(&self) -> i64 {
        (self.clock)()
    }

    fn lock_details(&self) -> LockDetails {
        LockDetails {
            repo: self.repo_dir.to_string_lossy().into_owned(),
            state_dir: self.state_dir.to_string_lossy().into_owned(),
            harness_version: self.harness_version.clone(),
            argv: std::env::args().collect(),
        }
    }

    fn versioned_state_path(&self) -> PathBuf {
        versioned_state_path(
            &self.state_dir,
            &self.repo_dir,
            self.harness_version.as_deref(),
        )
    }

    /// Takes the repository lock and publishes a fresh `idle` worker.
    pub fn start(&self, repository: &str) -> bool {
        let path = versioned_lock_path(&lock_path(&self.repo_dir), self.harness_version.as_deref());
        let details = self.lock_details();
        let lock_handle = match acquire_lock(&path, &details) {
            LockResult::Acquired(handle) => handle,
            LockResult::Busy(_) => {
                (self.log)(format!(
                    "already running for {} on {}",
                    self.repo_dir.display(),
                    self.harness_version
                        .as_deref()
                        .unwrap_or("an unknown version")
                ));
                return false;
            }
        };
        let previous = inherited_state_path(
            &self.versioned_state_path(),
            &versioned_state_files(&worker_state_directories(&self.state_dir, &self.repo_dir)),
            &state_path(&self.state_dir, &self.repo_dir),
        )
        .and_then(|path| load_state(&path));
        let settings = read_settings(&settings_path(&self.state_dir, &self.repo_dir))
            .unwrap_or_else(|| Settings {
                max_per_hour: previous
                    .as_ref()
                    .map(|state| state.limits.max_per_hour)
                    .unwrap_or(DEFAULT_MAX_PER_HOUR),
                max_pending: previous
                    .as_ref()
                    .map(|state| state.limits.max_pending)
                    .unwrap_or(DEFAULT_MAX_PENDING),
                interval_minutes: previous
                    .as_ref()
                    .map(|state| state.interval_minutes)
                    .unwrap_or(DEFAULT_INTERVAL_MINUTES),
            });
        let now_text = iso_from_millis(self.now());
        let mut state = empty_state(EmptyStateOptions {
            repo: repository.to_string(),
            root: self.repo_dir.to_string_lossy().into_owned(),
            lifecycle: Lifecycle::Idle,
            limit: Limits {
                max_per_hour: settings.max_per_hour,
                max_pending: settings.max_pending,
            },
            interval_minutes: settings.interval_minutes,
            now: now_text.clone(),
        });
        state.enabled = true;
        state.worker = Some(WorkerRecord {
            pid: std::process::id(),
            started_at: now_text,
            state_dir: self.state_dir.to_string_lossy().into_owned(),
            harness_version: self.harness_version.clone(),
            argv: std::env::args().collect(),
        });
        if let Some(previous) = previous {
            state.last_cycle_started_at = previous.last_cycle_started_at;
            state.issues = previous.issues;
            state.sync = previous.sync;
            state.newest_cycle_id = previous.newest_cycle_id;
            state.notice = previous.notice;
        }
        {
            let mut inner = lock(&self.inner);
            inner.state = state;
            let forge = inner.forge.clone();
            inner.forge = match forge {
                Some(forge) => Some(forge),
                None => create_forge(&self.repo_dir).ok(),
            };
            inner.next_sync_at = 0;
            inner.lock = Some(lock_handle);
            inner.last_saved = String::new();
        }
        self.publish();
        true
    }

    fn publish(&self) {
        let (state, text) = {
            let mut inner = lock(&self.inner);
            inner.state.updated_at = iso_from_millis(self.now());
            let text = serde_json::to_string(&inner.state.to_json()).unwrap_or_default();
            if text == inner.last_saved {
                return;
            }
            (inner.state.clone(), text)
        };
        match write_state(&self.versioned_state_path(), &state) {
            Ok(()) => lock(&self.inner).last_saved = text,
            Err(error) => (self.log)(format!("could not write state: {error}")),
        }
    }

    fn cadence_ms(&self) -> u64 {
        self.cadence_override_ms
            .unwrap_or_else(|| (lock(&self.inner).state.interval_minutes.max(1) as u64) * 60_000)
    }

    fn cadence_remaining(&self) -> bool {
        let inner = lock(&self.inner);
        let Some(last) = inner.state.last_cycle_started_at.as_deref() else {
            return false;
        };
        let Some(started) = parse_iso_millis(last) else {
            return false;
        };
        self.now() < started + self.cadence_ms() as i64
    }

    fn cadence_ready_at(&self, now: i64) -> Option<String> {
        let last = lock(&self.inner).state.last_cycle_started_at.clone()?;
        let started = parse_iso_millis(&last)?;
        let ready = started + self.cadence_ms() as i64;
        (ready > now).then(|| iso_from_millis(ready))
    }

    fn mark_stale(&self) {
        let (state, should) = {
            let mut inner = lock(&self.inner);
            if inner.cycling || inner.state.sync.state != SyncState::Ok {
                return;
            }
            let Some(at) = inner.state.sync.at.clone() else {
                return;
            };
            let Some(last) = parse_iso_millis(&at) else {
                return;
            };
            if self.now() - last <= 2 * self.sync_ms as i64 {
                return;
            }
            inner.state.sync = SyncStatus {
                state: SyncState::Stale,
                at: Some(at),
                error: Some(format!(
                    "no forge read has succeeded for more than {} seconds",
                    (2 * self.sync_ms) / 1000
                )),
            };
            (inner.state.clone(), true)
        };
        if should {
            let _ = state;
            self.publish();
        }
    }

    async fn consume_commands(&self) {
        {
            let mut inner = lock(&self.inner);
            if inner.consuming {
                return;
            }
            inner.consuming = true;
        }
        let versioned = versioned_control_directory(
            &self.state_dir,
            &self.repo_dir,
            self.harness_version.as_deref(),
        );
        let mut directories = vec![versioned];
        let legacy_live = live_lock_owners(&lock_path(&self.repo_dir))
            .into_iter()
            .any(|owner| owner.harness_version.is_none() && owner.pid != std::process::id());
        if !legacy_live {
            directories.push(control_directory(&self.state_dir, &self.repo_dir));
        }
        for directory in directories {
            for command in take_commands(&directory) {
                if lock(&self.inner).stopping {
                    break;
                }
                self.apply(command).await;
            }
        }
        lock(&self.inner).consuming = false;
    }

    async fn apply(&self, command: Command) {
        match command {
            Command::Stop => self.stop().await,
            Command::Drain => {
                let mut inner = lock(&self.inner);
                inner.draining = true;
                inner.state.draining = true;
                inner.state.last_error = None;
                inner.state.notice =
                    Some("Draining: this worker exits after its in-flight cycle.".to_string());
                drop(inner);
                self.publish();
            }
            Command::Limits {
                max_per_hour,
                max_pending,
            } => {
                if !is_valid_limit(Some(&json!(max_per_hour)))
                    || !is_valid_limit(Some(&json!(max_pending)))
                {
                    self.set_error(
                        "API Standards limits must be empty or integers from 1 through 100.",
                    );
                    return;
                }
                {
                    let mut inner = lock(&self.inner);
                    inner.state.limits = Limits {
                        max_per_hour,
                        max_pending,
                    };
                    inner.state.last_error = None;
                    inner.state.notice = Some(format!(
                        "Limits saved: {} per hour, {} open.",
                        limit_label(max_per_hour),
                        limit_label(max_pending)
                    ));
                }
                self.persist_settings();
                self.publish();
            }
            Command::Cadence { interval_minutes } => {
                if !is_valid_cadence(Some(&json!(interval_minutes))) {
                    self.set_error("API Standards cadence must be 1 through 1440 minutes.");
                    return;
                }
                {
                    let mut inner = lock(&self.inner);
                    inner.state.interval_minutes = interval_minutes;
                    inner.state.last_error = None;
                    inner.state.notice = Some(format!(
                        "Cadence saved: every {interval_minutes} minute(s)."
                    ));
                }
                self.persist_settings();
                self.publish();
            }
            Command::Settings {
                interval_minutes,
                max_per_hour,
                max_pending,
            } => {
                if !is_valid_cadence(Some(&json!(interval_minutes)))
                    || !is_valid_limit(Some(&json!(max_per_hour)))
                    || !is_valid_limit(Some(&json!(max_pending)))
                {
                    self.set_error(
                        "API Standards settings must be 1 through 1440 minutes and nullable 1..100 caps.",
                    );
                    return;
                }
                {
                    let mut inner = lock(&self.inner);
                    inner.state.interval_minutes = interval_minutes;
                    inner.state.limits = Limits {
                        max_per_hour,
                        max_pending,
                    };
                    inner.state.last_error = None;
                    inner.state.notice = Some("Settings saved.".to_string());
                }
                self.persist_settings();
                self.publish();
            }
        }
    }

    fn set_error(&self, message: &str) {
        lock(&self.inner).state.last_error = Some(message.to_string());
        self.publish();
    }

    fn persist_settings(&self) {
        let settings = {
            let inner = lock(&self.inner);
            Settings {
                max_per_hour: inner.state.limits.max_per_hour,
                max_pending: inner.state.limits.max_pending,
                interval_minutes: inner.state.interval_minutes,
            }
        };
        if let Err(error) =
            write_settings(&settings_path(&self.state_dir, &self.repo_dir), &settings)
        {
            (self.log)(format!("could not persist settings: {error}"));
        }
    }

    async fn read_forge(&self) -> Result<(Vec<IssueRow>, Vec<String>), String> {
        let forge = lock(&self.inner).forge.clone();
        let Some(forge) = forge else {
            return Err("no forge client is configured".to_string());
        };
        let (issues, open_titles) =
            tokio::join!(forge.list_issues(), forge.list_open_issue_titles());
        let issues = issues?;
        let open_titles = open_titles?;
        let previous = lock(&self.inner).state.issues.clone();
        let mut rows: Vec<IssueRow> = issues
            .into_iter()
            .map(|issue| {
                let category = previous
                    .iter()
                    .find(|row| row.number == issue.number)
                    .and_then(|row| row.category.clone())
                    .or_else(|| category_from_body(&issue.body));
                IssueRow {
                    number: issue.number,
                    title: issue.title,
                    url: issue.url,
                    created_at: issue.created_at,
                    state: if issue.state == "closed" {
                        IssueState::Implemented
                    } else {
                        IssueState::Pending
                    },
                    category,
                    version: None,
                }
            })
            .collect();
        rows.sort_by(newest_first);
        Ok((rows, open_titles))
    }

    async fn read_forge_within_deadline(&self) -> Result<(Vec<IssueRow>, Vec<String>), String> {
        match tokio::time::timeout(
            Duration::from_millis(self.read_timeout_ms),
            self.read_forge(),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => Err(format!(
                "the forge read did not finish within {} ms",
                self.read_timeout_ms
            )),
        }
    }

    pub async fn refresh(&self) {
        {
            let inner = lock(&self.inner);
            if inner.stopping || !inner.state.enabled || inner.syncing || inner.cycling {
                return;
            }
        }
        lock(&self.inner).syncing = true;
        let read = self.read_forge_within_deadline().await;
        match read {
            Err(detail) => self.record_sync_failure(&detail),
            Ok((issues, open_titles)) => {
                self.apply_read(issues, open_titles);
                lock(&self.inner).retry.succeed();
                lock(&self.inner).next_sync_at = self.now() + self.sync_ms as i64;
                self.publish();
            }
        }
        lock(&self.inner).syncing = false;
    }

    fn apply_read(&self, issues: Vec<IssueRow>, open_titles: Vec<String>) {
        {
            let mut inner = lock(&self.inner);
            inner.state.issues = issues;
            inner.open_titles = open_titles;
            inner.state.sync = SyncStatus {
                state: SyncState::Ok,
                at: Some(iso_from_millis(self.now())),
                error: None,
            };
            if !is_forge_rate_limited(inner.state.last_error.as_deref().unwrap_or("")) {
                inner.state.last_error = None;
            }
        }
        self.publish();
    }

    fn record_sync_failure(&self, detail: &str) {
        let kind = classify_forge_read_failure(detail);
        if kind == ForgeReadFailureKind::Transient {
            if let Some(delay) = lock(&self.inner).retry.record(kind) {
                let inner_at = lock(&self.inner).state.sync.at.clone();
                {
                    let mut inner = lock(&self.inner);
                    inner.state.sync = SyncStatus {
                        state: SyncState::Stale,
                        at: inner_at,
                        error: None,
                    };
                    inner.next_sync_at = self.now() + delay as i64;
                }
                self.publish();
                return;
            }
        } else {
            lock(&self.inner).retry.record(kind);
        }
        let at = lock(&self.inner).state.sync.at.clone();
        {
            let mut inner = lock(&self.inner);
            inner.state.sync = SyncStatus {
                state: SyncState::Error,
                at,
                error: Some(detail.to_string()),
            };
            inner.state.last_error =
                if kind == ForgeReadFailureKind::RateLimit || is_forge_rate_limited(detail) {
                    None
                } else {
                    Some(detail.to_string())
                };
            inner.state.notice = Some(format!("Could not read the forge: {detail}"));
            inner.next_sync_at = self.now() + self.sync_ms as i64;
        }
        self.publish();
    }

    /// Waits until the cycle in flight reaches a terminal state.
    pub async fn wait_for_cycle(&self) {
        loop {
            if !lock(&self.inner).cycling {
                return;
            }
            self.settled.notified().await;
        }
    }

    async fn tick(&self) {
        if lock(&self.inner).stopping {
            return;
        }
        self.consume_commands().await;
        if lock(&self.inner).stopping {
            return;
        }
        let draining = {
            let inner = lock(&self.inner);
            if !inner.state.enabled {
                return;
            }
            inner.draining
        };
        if draining {
            self.leave_if_idle().await;
            return;
        }
        self.mark_stale();
        {
            let inner = lock(&self.inner);
            if inner.syncing || inner.cycling {
                return;
            }
        }
        if self.now() >= lock(&self.inner).next_sync_at {
            self.refresh().await;
            if lock(&self.inner).stopping || !lock(&self.inner).state.enabled {
                return;
            }
            if lock(&self.inner).draining {
                self.leave_if_idle().await;
                return;
            }
        }
        {
            let inner = lock(&self.inner);
            if inner.active.is_some() || inner.starting {
                return;
            }
            if inner.state.sync.state != SyncState::Ok {
                return;
            }
        }
        if self.manual_cycles || self.cadence_remaining() {
            return;
        }
        self.begin_cycle().await;
    }

    pub async fn tick_now(&self) {
        self.tick().await;
    }

    async fn leave_if_idle(&self) {
        let idle = {
            let inner = lock(&self.inner);
            inner.active.is_none() && !inner.cycling && !inner.starting
        };
        if idle {
            self.stop().await;
        }
    }

    /// One tick, driven by the production loop.
    pub async fn run_once(&self) {
        self.tick().await;
    }

    pub async fn begin_cycle(&self) {
        {
            let inner = lock(&self.inner);
            if inner.stopping || inner.active.is_some() || inner.cycling {
                return;
            }
            if !inner.state.enabled {
                return;
            }
        }
        let Some(claim) = claim_cycle(
            &cycle_claim_path(&self.repo_dir),
            self.harness_version.as_deref(),
        ) else {
            return;
        };
        {
            let mut inner = lock(&self.inner);
            inner.cycle_claim = Some(claim);
            inner.starting = true;
            inner.cycling = true;
        }
        let now = self.now();
        let now_text = iso_from_millis(now);
        lock(&self.inner).state.last_cycle_started_at = Some(now_text.clone());
        let input = match read_audit_input(&self.repo_dir, &self.config) {
            Ok(input) => input,
            Err(detail) => {
                self.settle_with_failure(&detail, now);
                return;
            }
        };
        let (cycle_id, directory) = match create_cycle_directory(&self.repo_dir, now) {
            Ok(value) => value,
            Err(detail) => {
                self.settle_with_failure(&detail, now);
                return;
            }
        };
        let capacity = {
            let inner = lock(&self.inner);
            capacity_for(&inner.state.issues, &inner.state.limits, now)
        };
        let mut known_titles: Vec<String> = lock(&self.inner)
            .state
            .issues
            .iter()
            .map(|issue| issue.title.clone())
            .collect();
        known_titles.extend(lock(&self.inner).open_titles.clone());
        let room = capacity.batch;
        let repository = lock(&self.inner).state.repo.clone();
        let request = match write_cycle(
            &directory,
            WriteCycleOptions {
                cycle_id: &cycle_id,
                repository: &repository,
                repo_dir: &self.repo_dir,
                input: &input,
                config: &self.config,
                known_titles,
                issue_room: room,
                now_millis: now,
            },
        ) {
            Ok(request) => request,
            Err(error) => {
                self.settle_with_failure(&error.to_string(), now);
                return;
            }
        };
        let prompt = prompt_for(&directory);
        let initial_activity = vec![format!(
            "cycle {cycle_id}: audited {} route(s) and {} source file(s); {} rule(s) from {} and {}; room {}",
            input.routes.len(),
            input.sources.len(),
            input.skill.rules.len(),
            input.skill.skill_path,
            input.skill.rules_path,
            room
        )];
        let _ = request;
        let _ = write_activity(&directory, &initial_activity);
        self.settle_record(&directory, &initial_activity[0]);
        let heartbeat = CycleHeartbeat::new();
        let peer = {
            let environment = match self.provider_environment.resolve().await {
                Ok(environment) => environment
                    .into_iter()
                    .filter_map(|(key, value)| value.map(|value| (key, value)))
                    .collect::<HashMap<_, _>>(),
                Err(error) => {
                    self.settle_with_failure(&error.message, now);
                    return;
                }
            };
            let mut env = environment;
            env.insert(
                "REPO_DIR".to_string(),
                self.repo_dir.to_string_lossy().into_owned(),
            );
            env.insert(
                "STATE_DIR".to_string(),
                self.state_dir.to_string_lossy().into_owned(),
            );
            env.insert(
                "DEVBOARD_TOOL_LOG".to_string(),
                directory
                    .join("tool-log.jsonl")
                    .to_string_lossy()
                    .into_owned(),
            );
            let weakness = Arc::downgrade(&Arc::new(()));
            let _ = weakness;
            let callbacks = self.callbacks_for(&cycle_id, Arc::clone(&heartbeat));
            (self.connect)(PeerOptions {
                command: self.agent_command.clone(),
                cwd: directory.clone(),
                env,
                callbacks,
            })
            .await
        };
        let peer = match peer {
            Ok(peer) => peer,
            Err(detail) => {
                self.settle_with_failure(&detail, now);
                return;
            }
        };
        let active = ActiveCycle {
            cycle_id: cycle_id.clone(),
            directory: directory.clone(),
            activity: initial_activity,
            peer,
            heartbeat,
            first_line: None,
            finished: false,
            input,
        };
        {
            let mut inner = lock(&self.inner);
            inner.active = Some(active);
            inner.state.newest_cycle_id = Some(cycle_id.clone());
            inner.state.lifecycle = Lifecycle::Auditing;
            inner.state.last_error = None;
            inner.state.next_attempt_at = None;
            inner.starting = false;
        }
        self.publish();
        self.spawn_cycle(cycle_id, prompt);
    }

    fn callbacks_for(&self, cycle_id: &str, heartbeat: Arc<CycleHeartbeat>) -> PeerCallbacks {
        let activity_id = cycle_id.to_string();
        let activity_worker: Arc<dyn WorkerHandle> = match self.weak.upgrade() {
            Some(worker) => worker,
            None => return PeerCallbacks::default(),
        };
        let stderr_id = cycle_id.to_string();
        let stderr_worker = match self.weak.upgrade() {
            Some(worker) => worker,
            None => return PeerCallbacks::default(),
        };
        let heartbeat_for_activity = Arc::clone(&heartbeat);
        let heartbeat_for_update = Arc::clone(&heartbeat);
        PeerCallbacks {
            on_activity: Some(Arc::new(move |entry: AcpActivity| {
                heartbeat_for_activity.beat();
                activity_worker.record_activity(&activity_id, entry);
            })),
            on_stderr: Some(Arc::new(move |text: String| {
                stderr_worker.record_stderr(&stderr_id, &text);
            })),
            on_session_update: Some(Arc::new(move || heartbeat_for_update.beat())),
        }
    }

    fn spawn_cycle(&self, cycle_id: String, prompt: String) {
        let Some(worker) = self.self_arc() else {
            return;
        };
        tokio::spawn(async move {
            let peer = {
                let inner = lock(&worker.inner);
                inner
                    .active
                    .as_ref()
                    .filter(|active| active.cycle_id == cycle_id)
                    .map(|active| Arc::clone(&active.peer))
            };
            let Some(peer) = peer else {
                return;
            };
            let heartbeat = {
                let inner = lock(&worker.inner);
                inner
                    .active
                    .as_ref()
                    .filter(|active| active.cycle_id == cycle_id)
                    .map(|active| Arc::clone(&active.heartbeat))
            };
            let Some(heartbeat) = heartbeat else {
                return;
            };
            let outcome = run_peer_until_idle(peer, prompt, heartbeat, worker.timeout_ms).await;
            match outcome {
                Ok(()) => worker.complete_cycle(&cycle_id).await,
                Err(detail) => {
                    let detail = if detail.is_empty() {
                        "the agent failed".to_string()
                    } else {
                        detail
                    };
                    worker.fail_cycle(&cycle_id, &detail);
                }
            }
        });
    }

    fn self_arc(&self) -> Option<Arc<Worker>> {
        self.weak.upgrade()
    }

    fn settle_record(&self, directory: &Path, line: &str) {
        let active = {
            let mut inner = lock(&self.inner);
            inner
                .active
                .as_mut()
                .filter(|active| active.directory == directory)
                .map(|active| {
                    append_activity_line(&mut active.activity, line, false);
                    active.activity.clone()
                })
        };
        if let Some(activity) = active {
            let _ = write_activity(directory, &activity);
        }
    }

    fn record_activity_line(&self, cycle_id: &str, line: &str) {
        let activity = {
            let mut inner = lock(&self.inner);
            inner.active.as_mut().and_then(|active| {
                if active.cycle_id != cycle_id {
                    return None;
                }
                append_activity_line(&mut active.activity, line, false);
                Some((active.directory.clone(), active.activity.clone()))
            })
        };
        if let Some((directory, activity)) = activity {
            let _ = write_activity(&directory, &activity);
        }
    }

    fn settle_with_failure(&self, detail: &str, now: i64) {
        {
            let mut inner = lock(&self.inner);
            inner.state.lifecycle = Lifecycle::Idle;
            inner.state.last_error = Some(detail.to_string());
            inner.state.notice = Some(format!("Audit failed: {detail}"));
            inner.state.next_attempt_at = Some(iso_from_millis(now + self.sync_ms as i64));
            inner.cycling = false;
            inner.starting = false;
            if let Some(claim) = inner.cycle_claim.take() {
                claim.release();
            }
        }
        self.publish();
        self.settled.notify_one();
        if lock(&self.inner).draining {
            if let Some(worker) = self.self_arc() {
                tokio::spawn(async move {
                    worker.stop().await;
                });
            }
        }
    }

    async fn complete_cycle(&self, cycle_id: &str) {
        let active = {
            let mut inner = lock(&self.inner);
            let matches = inner
                .active
                .as_ref()
                .is_some_and(|active| active.cycle_id == cycle_id && !active.finished);
            if !matches {
                return;
            }
            if let Some(active) = inner.active.as_mut() {
                active.finished = true;
                Some((
                    active.directory.clone(),
                    active.input.clone(),
                    Arc::clone(&active.peer),
                ))
            } else {
                None
            }
        };
        let Some((directory, input, peer)) = active else {
            return;
        };
        peer.close();
        let mut error: Option<String> = None;
        let record = |text: String| self.record_activity_line(cycle_id, &text);
        let filed = self.filed_issues(&directory, &mut error, &record);
        match read_findings(&directory) {
            None => {
                if filed.is_empty() {
                    record("finished without a findings answer".to_string());
                }
            }
            Some(answer) => {
                let sources: HashMap<String, String> = input
                    .sources
                    .iter()
                    .map(|file| (file.path.clone(), file.text.clone()))
                    .collect();
                let context = FindingContext {
                    rules: &input.skill.rules,
                    sources: &sources,
                };
                let mut claimed: HashSet<String> = HashSet::new();
                for finding in answer.findings {
                    let key = crate::forge::normalize_issue_title(&finding.title);
                    if finding.decision == "skipped" {
                        let reason = finding.reason.unwrap_or_else(|| "skipped".to_string());
                        record(format!(
                            "skipped ({reason}) rule {} {}: {}",
                            if finding.rule_id.is_empty() {
                                "—"
                            } else {
                                &finding.rule_id
                            },
                            if finding.level.is_empty() {
                                "—"
                            } else {
                                &finding.level
                            },
                            finding.title
                        ));
                        continue;
                    }
                    let problem = validate_finding(&finding.to_json(), &context);
                    let rule = match problem {
                        FindingProblem::Ok(rule) => rule,
                        FindingProblem::Problem { reason, detail } => {
                            record(format!(
                                "dropped ({}): {} — {}",
                                reason.as_str(),
                                if finding.title.is_empty() {
                                    "(no title)"
                                } else {
                                    &finding.title
                                },
                                detail
                            ));
                            continue;
                        }
                    };
                    let Some(created) = filed.get(&key) else {
                        record(format!(
                            "failed: no issue was created for “{}”",
                            finding.title
                        ));
                        if error.is_none() {
                            error = Some(format!(
                                "the issue-creation tool recorded no filing for “{}”",
                                finding.title
                            ));
                        }
                        continue;
                    };
                    claimed.insert(key);
                    record(format!(
                        "admissible rule {} {} · {}: {}",
                        rule.id, rule.level, rule.chapter, created.title
                    ));
                    record(format!("filed #{} {}", created.number, created.url));
                }
                for (key, created) in &filed {
                    if claimed.contains(key) {
                        continue;
                    }
                    record(format!(
                        "filed #{} {} “{}”",
                        created.number, created.url, created.title
                    ));
                }
            }
        }
        if !filed.is_empty() || !lock(&self.inner).state.issues.is_empty() {
            match self.read_forge_within_deadline().await {
                Ok((issues, open_titles)) => self.apply_read(issues, open_titles),
                Err(failure) => record(format!("could not re-read the forge: {failure}")),
            }
        }
        self.finish_cycle(&directory, cycle_id, error);
    }

    fn filed_issues(
        &self,
        directory: &Path,
        error: &mut Option<String>,
        record: &dyn Fn(String),
    ) -> HashMap<String, FiledIssue> {
        let mut filed = HashMap::new();
        let path = directory.join("tool-log.jsonl");
        for entry in super::mcp_optimizer::read_tool_log(&path) {
            if entry.get("tool").and_then(Value::as_str) != Some("issue_create") {
                continue;
            }
            let number = tool_value_number(entry.get("value"), "number");
            let title = tool_value_string(entry.get("value"), "title");
            let url = tool_value_string(entry.get("value"), "url");
            if entry.get("ok").and_then(Value::as_bool) == Some(true)
                && number.is_some()
                && title.is_some()
            {
                let number = number.unwrap_or(0);
                let title = title.unwrap_or_default();
                filed.insert(
                    crate::forge::normalize_issue_title(&title),
                    FiledIssue {
                        number,
                        url: url.unwrap_or_default(),
                        title,
                    },
                );
                continue;
            }
            let detail = entry
                .get("error")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .unwrap_or("the issue-creation tool failed")
                .to_string();
            if error.is_none() {
                *error = Some(detail.clone());
            }
            record(format!("failed: {detail}"));
        }
        filed
    }

    fn fail_cycle(&self, cycle_id: &str, detail: &str) {
        let (directory, first_line) = {
            let mut inner = lock(&self.inner);
            let Some(active) = inner.active.as_mut() else {
                return;
            };
            if active.cycle_id != cycle_id || active.finished {
                return;
            }
            active.finished = true;
            let first = active.first_line.clone();
            if let Some(peer) = Some(Arc::clone(&active.peer)) {
                peer.close();
            }
            (active.directory.clone(), first)
        };
        let error = first_line.unwrap_or_else(|| detail.to_string());
        self.record_activity_line(cycle_id, &format!("failed: {error}"));
        let now = self.now();
        {
            let mut inner = lock(&self.inner);
            if inner
                .active
                .as_ref()
                .is_some_and(|active| active.cycle_id == cycle_id)
            {
                inner.active = None;
            }
            inner.cycling = false;
            inner.starting = false;
            if let Some(claim) = inner.cycle_claim.take() {
                claim.release();
            }
            if inner.stopping {
                return;
            }
            inner.state.lifecycle = Lifecycle::Idle;
            inner.state.last_error = Some(error.clone());
            inner.state.notice = Some(format!("Audit failed: {error}"));
            inner.state.next_attempt_at = Some(iso_from_millis(now + self.sync_ms as i64));
        }
        let _ = directory;
        self.publish();
        self.settled.notify_one();
        if lock(&self.inner).draining {
            if let Some(worker) = self.self_arc() {
                tokio::spawn(async move {
                    worker.stop().await;
                });
            }
        }
    }

    fn finish_cycle(&self, _directory: &Path, cycle_id: &str, error: Option<String>) {
        let now = self.now();
        let cadence_at = self.cadence_ready_at(now);
        let cooldown_at = iso_from_millis(now + self.sync_ms as i64);
        {
            let mut inner = lock(&self.inner);
            if inner
                .active
                .as_ref()
                .is_some_and(|active| active.cycle_id == cycle_id)
            {
                inner.active = None;
            }
            inner.cycling = false;
            inner.starting = false;
            if let Some(claim) = inner.cycle_claim.take() {
                claim.release();
            }
            if inner.stopping {
                return;
            }
            inner.state.lifecycle = Lifecycle::Idle;
            inner.state.last_error = error.clone();
            if let Some(error) = &error {
                inner.state.notice = Some(format!("API Standards cycle failed: {error}"));
            }
            inner.state.next_attempt_at = match (cadence_at, cooldown_at.as_str()) {
                (Some(cadence), cooldown) => {
                    if parse_iso_millis(&cadence) >= parse_iso_millis(cooldown) {
                        Some(cadence)
                    } else {
                        Some(cooldown.to_string())
                    }
                }
                (None, cooldown) => Some(cooldown.to_string()),
            };
        }
        self.publish();
        self.settled.notify_one();
        if lock(&self.inner).draining {
            if let Some(worker) = self.self_arc() {
                tokio::spawn(async move {
                    worker.stop().await;
                });
            }
        }
    }

    /// Stop: end the peer, keep the rows, limits, and last read.
    pub async fn stop(&self) {
        {
            let inner = lock(&self.inner);
            if inner.stopping {
                return;
            }
        }
        let stopped = {
            let mut inner = lock(&self.inner);
            inner.stopping = true;
            inner.active.take().map(|mut active| {
                active.finished = true;
                append_activity_line(&mut active.activity, "stopped", false);
                (
                    Arc::clone(&active.peer),
                    active.directory.clone(),
                    active.activity,
                )
            })
        };
        if let Some((peer, directory, activity)) = stopped {
            peer.close();
            let _ = write_activity(&directory, &activity);
        }
        {
            let mut inner = lock(&self.inner);
            inner.cycling = false;
            inner.starting = false;
            if let Some(claim) = inner.cycle_claim.take() {
                claim.release();
            }
            inner.state.enabled = false;
            inner.state.lifecycle = Lifecycle::Stopped;
            inner.state.next_attempt_at = None;
            inner.state.last_error = None;
            inner.state.notice = if inner.draining {
                Some("Drained: exited after its in-flight cycle.".to_string())
            } else {
                None
            };
            if let Some(lock) = inner.lock.take() {
                lock.release();
            }
        }
        self.publish();
        self.settled.notify_one();
    }

    pub async fn shutdown(&self) {
        self.stop().await;
    }
}

/* ------------------------------------------------------------------------ */
/* Activity callbacks without a second allocation                            */
/* ------------------------------------------------------------------------ */

trait WorkerHandle: Send + Sync {
    fn record_activity(&self, cycle_id: &str, entry: AcpActivity);
    fn record_stderr(&self, cycle_id: &str, text: &str);
}

impl WorkerHandle for Worker {
    fn record_activity(&self, cycle_id: &str, entry: AcpActivity) {
        let activity = {
            let mut inner = lock(&self.inner);
            inner.active.as_mut().and_then(|active| {
                if active.cycle_id != cycle_id || active.finished {
                    return None;
                }
                append_activity_line(&mut active.activity, &entry.text, entry.append);
                Some((active.directory.clone(), active.activity.clone()))
            })
        };
        if let Some((directory, activity)) = activity {
            let _ = write_activity(&directory, &activity);
        }
    }

    fn record_stderr(&self, cycle_id: &str, text: &str) {
        let mut inner = lock(&self.inner);
        let Some(active) = inner.active.as_mut() else {
            return;
        };
        if active.cycle_id != cycle_id || active.finished || active.first_line.is_some() {
            return;
        }
        let line = bounded_line(text);
        if !line.is_empty() {
            active.first_line = Some(line);
        }
    }
}

/* ------------------------------------------------------------------------ */
/* Small shared helpers                                                      */
/* ------------------------------------------------------------------------ */

#[derive(Clone, Debug)]
struct FiledIssue {
    number: i64,
    url: String,
    title: String,
}

fn newest_first(left: &IssueRow, right: &IssueRow) -> std::cmp::Ordering {
    match (
        parse_iso_millis(&left.created_at),
        parse_iso_millis(&right.created_at),
    ) {
        (Some(left_at), Some(right_at)) if left_at != right_at => right_at.cmp(&left_at),
        _ => right.number.cmp(&left.number),
    }
}

pub fn normalize_title(title: &str) -> String {
    crate::forge::normalize_issue_title(title)
}

pub fn limit_label(value: Option<i64>) -> String {
    value
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unlimited".to_string())
}

fn bounded_line(text: &str) -> String {
    let line = text
        .split('\n')
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    if line.chars().count() <= FIRST_LINE_MAX {
        line.to_string()
    } else {
        let mut bounded: String = line.chars().take(FIRST_LINE_MAX - 1).collect();
        bounded.push('…');
        bounded
    }
}

fn tool_value_number(value: Option<&Value>, field: &str) -> Option<i64> {
    let record = value?.as_object()?;
    record
        .get(field)
        .and_then(Value::as_i64)
        .filter(|number| *number > 0)
}

fn tool_value_string(value: Option<&Value>, field: &str) -> Option<String> {
    value?.as_object()?.get(field)?.as_str().map(str::to_string)
}

const RATE_LIMIT_PATTERNS: [&str; 5] = [
    "rate limit exceeded",
    "secondary rate limit",
    "abuse detection",
    "too many requests",
    "http 429",
];

pub fn is_forge_rate_limited(text: &str) -> bool {
    let message = text.to_ascii_lowercase();
    RATE_LIMIT_PATTERNS
        .iter()
        .any(|pattern| message.contains(pattern))
}

/* ------------------------------------------------------------------------ */
/* CLI                                                                       */
/* ------------------------------------------------------------------------ */

fn parse_arguments(invocation: &WorkerInvocation) -> Option<(PathBuf, PathBuf, Option<u64>, bool)> {
    let repo_dir =
        (!invocation.repo_dir.as_os_str().is_empty()).then(|| invocation.repo_dir.clone())?;
    let state_dir =
        (!invocation.state_dir.as_os_str().is_empty()).then(|| invocation.state_dir.clone())?;
    let mut sync_ms = None;
    let mut once = false;
    let mut index = 0;
    while index < invocation.rest.len() {
        let argument = invocation.rest[index].as_str();
        if argument == "--sync" {
            let value = invocation.rest.get(index + 1)?;
            index += 2;
            match value.parse::<u64>() {
                Ok(parsed) if parsed >= 1000 => sync_ms = Some(parsed),
                Ok(_) => {}
                Err(_) => return None,
            }
            continue;
        }
        if argument == "--once" {
            once = true;
            index += 1;
            continue;
        }
        index += 1;
    }
    Some((absolute(&repo_dir), absolute(&state_dir), sync_ms, once))
}

/// Runs one API Standards worker until Stop or drain.
pub async fn run(invocation: &WorkerInvocation) -> anyhow::Result<()> {
    let Some((repo_dir, state_dir, sync_ms, once)) = parse_arguments(invocation) else {
        eprintln!(
            "usage: devboard worker api-standards --repo <checkout> --state-dir <dir> [--sync <ms>] [--once]"
        );
        std::process::exit(2);
    };
    let environment = crate::forge::process_environment();
    let repository =
        crate::forge::origin_repository_with(&repo_dir, &environment).unwrap_or_default();
    if repository.is_empty() {
        eprintln!("api-standards worker: the checkout's origin does not name a repository");
        std::process::exit(2);
    }
    let harness_version = std::env::var("DEVBOARD_HARNESS_VERSION")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| {
            let harness = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .and_then(Path::parent)
                .map(Path::to_path_buf)?;
            read_harness_version(&harness)
        });
    if live_lock_owner(&versioned_lock_path(
        &lock_path(&repo_dir),
        harness_version.as_deref(),
    ))
    .is_some()
    {
        eprintln!(
            "api-standards worker: this checkout already has a live api-standards agent for this version"
        );
        std::process::exit(0);
    }
    let mut options = WorkerOptions::new(&repo_dir, &state_dir);
    options.harness_version = harness_version;
    options.sync_ms = sync_ms;
    options.manual_cycles = once;
    options.log = Some(Arc::new(|line: String| eprintln!("api-standards: {line}")));
    let worker = Worker::new(options);
    if !worker.start(&repository) {
        std::process::exit(0);
    }
    if once {
        // One cycle, settled before the process exits: `request.json` and the
        // filed issues are on disk when `--once` returns.
        worker.run_once().await;
        let deadline =
            tokio::time::Instant::now() + Duration::from_millis(worker.cycle_timeout_ms() + 10_000);
        while !worker.is_settled() && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        worker.shutdown().await;
        return Ok(());
    }
    let mut ticker = tokio::time::interval(Duration::from_millis(worker.tick_ms()));
    loop {
        tokio::select! {
            _ = ticker.tick() => {
                worker.run_once().await;
            }
            _ = shutdown_signal() => {
                eprintln!("api-standards: received a shutdown signal");
                worker.shutdown().await;
                return Ok(());
            }
        }
        if worker.is_stopped() {
            return Ok(());
        }
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut terminate = match signal(SignalKind::terminate()) {
            Ok(signal) => signal,
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
                return;
            }
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/* ------------------------------------------------------------------------ */
/* Preflight                                                                 */
/* ------------------------------------------------------------------------ */

#[derive(Clone)]
pub struct PreflightOptions {
    pub repo_dir: PathBuf,
    pub state_dir: PathBuf,
    pub environment: HashMap<String, String>,
    pub config: Config,
    pub origin: Option<ForgeRemote>,
    pub run: Option<
        Arc<
            dyn Fn(Vec<String>) -> Pin<Box<dyn Future<Output = crate::forge::ExecResult> + Send>>
                + Send
                + Sync,
        >,
    >,
    pub gitea_transport: Option<crate::forge::Transport>,
}

impl Default for PreflightOptions {
    fn default() -> Self {
        Self {
            repo_dir: PathBuf::new(),
            state_dir: PathBuf::new(),
            environment: crate::forge::process_environment(),
            config: Config::default(),
            origin: None,
            run: None,
            gitea_transport: None,
        }
    }
}

fn first_line(text: &str) -> Option<String> {
    text.split('\n')
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

fn inside(root: &Path, path: &Path) -> bool {
    let root = absolute(root);
    let path = absolute(path);
    let relative = path.strip_prefix(&root).ok();
    match relative {
        None => false,
        Some(local) => {
            let text = local.to_string_lossy();
            !text.is_empty() && !text.starts_with("..")
        }
    }
}

/// Everything Start proves before it spawns the worker.
pub async fn preflight_api_standards(options: &PreflightOptions) -> Result<String, String> {
    let environment = &options.environment;
    let config = &options.config;
    let root = absolute(&options.repo_dir);

    let source_root = root.join(&config.source_dir);
    if !source_root.exists() {
        return Err(format!(
            "missing prerequisite: the canonical harness source checkout has no {} directory \
             (an installed npm prefix is refused)",
            config.source_dir
        ));
    }
    let metadata = std::fs::symlink_metadata(&source_root).map_err(|_| {
        format!(
            "missing prerequisite: {} is not readable",
            config.source_dir
        )
    })?;
    if !metadata.is_dir() {
        return Err(format!(
            "missing prerequisite: {} is not a directory",
            config.source_dir
        ));
    }
    if let Err(detail) = read_rest_skill(&root, config) {
        return Err(format!(
            "missing prerequisite: the REST skill is unusable: {detail}"
        ));
    }
    if !inside(&options.repo_dir, &options.state_dir) {
        return Err(format!(
            "STATE_DIR {} is not inside REPO_DIR {}; the api-standards worker keeps its state beside the checkout",
            absolute(&options.state_dir).display(),
            root.display()
        ));
    }
    let remote = options
        .origin
        .clone()
        .or_else(|| crate::forge::origin_forge_with(&root, environment));
    let Some(remote) = remote else {
        return Err("the checkout's origin does not name a supported repository".to_string());
    };
    if remote.forge == Forge::GitLab {
        return Err(format!(
            "the API Standards agent supports a GitHub or Gitea origin, not a GitLab one: {}",
            remote.host
        ));
    }
    let repository = remote.project.clone();
    if remote.forge == Forge::Gitea {
        return preflight_gitea(options, &remote, &repository).await;
    }
    type RunFn = dyn Fn(Vec<String>) -> Pin<Box<dyn Future<Output = crate::forge::ExecResult> + Send>>
        + Send
        + Sync;
    let run: Arc<RunFn> = options.run.clone().unwrap_or_else(|| {
        let exec = crate::forge::default_exec();
        let environment = environment.clone();
        Arc::new(move |argv: Vec<String>| {
            let exec = exec.clone();
            let environment = environment.clone();
            Box::pin(async move {
                exec(
                    "gh".to_string(),
                    argv,
                    crate::forge::ExecOptions {
                        env: environment,
                        ..Default::default()
                    },
                )
                .await
            })
        })
    });
    let permission = run(vec![
        "api".to_string(),
        format!("repos/{repository}"),
        "--jq".to_string(),
        ".permissions.push".to_string(),
    ])
    .await;
    if permission.code != 0 || permission.stdout.trim() != "true" {
        let detail = first_line(&permission.stderr)
            .or_else(|| first_line(&permission.stdout))
            .unwrap_or_else(|| format!("gh exited with code {}", permission.code));
        return Err(format!(
            "missing prerequisite: 'gh api repos/{repository} --jq .permissions.push' did not return true: {detail}"
        ));
    }
    let label = run(vec![
        "api".to_string(),
        format!("repos/{repository}/labels/{API_STANDARDS_LABEL}"),
        "--jq".to_string(),
        ".name".to_string(),
    ])
    .await;
    if label.code != 0 || label.stdout.trim() != API_STANDARDS_LABEL {
        let created = run(vec![
            "label".to_string(),
            "create".to_string(),
            API_STANDARDS_LABEL.to_string(),
            "--repo".to_string(),
            repository.clone(),
            "--color".to_string(),
            LABEL_COLOR.to_string(),
            "--description".to_string(),
            LABEL_DESCRIPTION.to_string(),
            "--force".to_string(),
        ])
        .await;
        if created.code != 0 {
            return Err(format!(
                "missing prerequisite: the \"{API_STANDARDS_LABEL}\" label could not be created in {repository}: {}",
                first_line(&created.stderr).unwrap_or_else(|| format!("gh exited with code {}", created.code))
            ));
        }
    }
    Ok(repository)
}

async fn preflight_gitea(
    options: &PreflightOptions,
    remote: &ForgeRemote,
    repository: &str,
) -> Result<String, String> {
    let Some(base_url) = crate::forge::gitea_base_url(Some(remote), &options.environment) else {
        return Err("missing prerequisite: the Gitea address is not configured \
             (set DEVBOARD_GITEA_URL or use an HTTP(S) origin)"
            .to_string());
    };
    let Some(token) = crate::forge::configured_gitea_token(&options.environment) else {
        return Err("missing prerequisite: GITEA_TOKEN is not set".to_string());
    };
    let transport = options
        .gitea_transport
        .clone()
        .unwrap_or_else(|| crate::forge::default_transport(30_000));
    let target = crate::forge::GiteaTarget {
        base_url: base_url.clone(),
        project: repository.to_string(),
        token: Some(token),
    };
    let call_options = crate::forge::GiteaCallOptions::default();
    let document = crate::forge::gitea_repository(&target, &transport, &call_options)
        .await
        .map_err(|error| {
            format!(
                "missing prerequisite: the Gitea repository {repository} could not be read: {}",
                error.message
            )
        })?;
    let writable = document
        .permissions()
        .and_then(Value::as_object)
        .map(|permissions| {
            permissions.get("push").and_then(Value::as_bool) == Some(true)
                || permissions.get("admin").and_then(Value::as_bool) == Some(true)
        })
        .unwrap_or(false);
    if !writable {
        return Err(format!(
            "missing prerequisite: the Gitea token cannot write to {repository} on {base_url}"
        ));
    }
    let labels = crate::forge::gitea_labels(&target, &transport, &call_options)
        .await
        .map_err(|error| {
            format!(
                "missing prerequisite: the Gitea repository {repository} could not be read: {}",
                error.message
            )
        })?;
    if !labels.iter().any(|label| label.name == API_STANDARDS_LABEL) {
        match crate::forge::gitea_create_label(
            &target,
            API_STANDARDS_LABEL,
            LABEL_COLOR,
            LABEL_DESCRIPTION,
            &transport,
            &call_options,
        )
        .await
        {
            Ok(_) => {}
            Err(error) => {
                let after = crate::forge::gitea_labels(&target, &transport, &call_options).await;
                let present = after
                    .map(|labels| labels.iter().any(|label| label.name == API_STANDARDS_LABEL))
                    .unwrap_or(false);
                if !present {
                    return Err(format!(
                        "missing prerequisite: the \"{API_STANDARDS_LABEL}\" label could not be created in {repository}: {}",
                        error.message
                    ));
                }
            }
        }
    }
    Ok(repository.to_string())
}

#[cfg(test)]
mod length_tests {
    use super::*;

    fn title_problem(title: &str) -> String {
        let rules: Vec<RestRule> = Vec::new();
        let sources: HashMap<String, String> = HashMap::new();
        let context = FindingContext {
            rules: &rules,
            sources: &sources,
        };
        match validate_finding(&json!({"title": title}), &context) {
            FindingProblem::Problem { detail, .. } => detail,
            FindingProblem::Ok(_) => String::new(),
        }
    }

    #[test]
    fn the_finding_title_cap_counts_code_points() {
        let emoji_at_cap = "😀".repeat(TITLE_MAX);
        assert_eq!(emoji_at_cap.chars().count(), TITLE_MAX);
        assert!(!title_problem(&emoji_at_cap).contains("title must be"));
        let emoji_over = "😀".repeat(TITLE_MAX + 1);
        assert!(title_problem(&emoji_over).contains("title must be"));
        let plain_at_cap = "a".repeat(TITLE_MAX);
        assert!(!title_problem(&plain_at_cap).contains("title must be"));
        let plain_over = "a".repeat(TITLE_MAX + 1);
        assert!(title_problem(&plain_over).contains("title must be"));
    }
}
