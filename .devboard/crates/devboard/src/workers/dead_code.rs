//! The detached Dead Code worker.
//!
//! One worker per repository and harness version crawls from a seeded entry
//! point, one cycle at a time. The agent proves each removable unit and files
//! its own finding through the Devboard MCP issue tool; the worker records the
//! filing and resolves the release that shipped each closed row. It never
//! writes the checkout.
//!
//! The durable surface mirrors the TypeScript worker: state and settings under
//! `<STATE_DIR>/dead-code/<repo key>/`, the lock, cross-version cycle lease,
//! and one cycle directory per run under `.devboard/.tmp/dead-code/`.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use serde_json::{json, Value};

use crate::acp::AcpActivity;
use crate::forge::{
    classify_forge_read_failure, Forge, ForgeReadFailureKind, ForgeReadRetry, ForgeRemote,
};
use crate::journal::journal_key;
use crate::providers::{
    create_worker_provider_environment, Env, ProviderOptions, WorkerProviderEnvironment,
};
use crate::version::read_harness_version;

use super::api_standards::run_peer_until_idle;
use super::api_standards::{
    absolute, append_activity_line, default_connect, iso_from_millis, json_text, parse_iso_millis,
    write_activity, write_atomic, Clock, ConnectFn, CycleHeartbeat, Peer, PeerCallbacks,
    PeerOptions,
};
use super::mcp_optimizer::now_iso;
use super::watchdog::{
    acquire_lock, claim_cycle, live_lock_owner, live_lock_owners, versioned_lock_path, ClaimHandle,
    LockDetails, LockHandle, LockResult,
};
use super::WorkerInvocation;

/* ------------------------------------------------------------------------ */
/* Constants and paths                                                       */
/* ------------------------------------------------------------------------ */

pub const DEAD_CODE_DIRECTORY: &str = "dead-code";
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
pub const RESOLUTION_RETRY_MS: i64 = 6 * HOUR_MS;

pub const DEAD_CODE_LABEL: &str = "dead-code";
pub const LABEL_COLOR: &str = "8250df";
pub const LABEL_DESCRIPTION: &str = "Dead code proved removable by the Dead Code agent";
pub const DEAD_CODE_CATEGORIES: [&str; 5] = [
    "unreferenced-file",
    "unreferenced-symbol",
    "unreachable-branch",
    "unused-dependency",
    "unmatched-selector",
];

pub const TICK_MS: u64 = 100;
pub const DEFAULT_AGENT_COMMAND: &str = "omp acp";
pub const FIRST_LINE_MAX: usize = 400;
pub const MAX_ACTIVITY_LINE: usize = 2000;
pub const READ_TIMEOUT_MS: u64 = 30_000;
pub const CYCLE_TIMEOUT_MS: u64 = 20 * 60_000;

pub fn dead_code_root(state_dir: &Path) -> PathBuf {
    state_dir.join(DEAD_CODE_DIRECTORY)
}

pub fn repo_state_directory(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    dead_code_root(state_dir).join(journal_key(&absolute(repo_dir)))
}

pub fn state_path(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    repo_state_directory(state_dir, repo_dir).join("state.json")
}

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

pub fn work_directory(repo_dir: &Path) -> PathBuf {
    absolute(repo_dir)
        .join(".devboard")
        .join(".tmp")
        .join(DEAD_CODE_DIRECTORY)
}

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

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

/* ------------------------------------------------------------------------ */
/* Published state                                                           */
/* ------------------------------------------------------------------------ */

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lifecycle {
    Stopped,
    Idle,
    Detecting,
    Failed,
}

impl Lifecycle {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::Idle => "idle",
            Self::Detecting => "detecting",
            Self::Failed => "failed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "stopped" => Some(Self::Stopped),
            "idle" => Some(Self::Idle),
            "detecting" => Some(Self::Detecting),
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
    pub version_attempt_at: Option<String>,
    pub version_error: Option<String>,
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
            "versionAttemptAt": self.version_attempt_at,
            "versionError": self.version_error,
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
    pub release_signature: Option<String>,
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
            "releaseSignature": self.release_signature,
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
        release_signature: None,
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
        version_attempt_at: record
            .get("versionAttemptAt")
            .and_then(Value::as_str)
            .map(str::to_string),
        version_error: record
            .get("versionError")
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
    if pid <= 0 || !nullable_string(record.get("harnessVersion")) {
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
        || !nullable_string(record.get("releaseSignature"))
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
        release_signature: record
            .get("releaseSignature")
            .and_then(Value::as_str)
            .map(str::to_string),
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

pub fn read_settings(path: &Path) -> Option<Settings> {
    parse_settings(&std::fs::read_to_string(path).ok()?)
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
        .unwrap_or(100);
    let pending_room = limits
        .max_pending
        .map(|limit| (limit - open_count).max(0))
        .unwrap_or(100);
    Capacity {
        batch: hourly_room.min(pending_room).min(CYCLE_ISSUE_LIMIT),
        window_count,
        open_count,
        hourly_room,
        pending_room,
    }
}

/// The `## Category` line of an issue body, for adopted rows.
pub fn category_from_body(body: &str) -> Option<String> {
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
        return (value.chars().count() <= 40).then(|| value.to_string());
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
    Refresh,
    Settings {
        interval_minutes: i64,
        max_per_hour: Option<i64>,
        max_pending: Option<i64>,
    },
}

static COMMAND_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn command_json(command: &Command) -> Value {
    match command {
        Command::Stop => json!({"type": "stop"}),
        Command::Drain => json!({"type": "drain"}),
        Command::Refresh => json!({"type": "refresh"}),
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

pub fn parse_command(text: &str) -> Option<Command> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    let record = parsed.as_object()?;
    match record.get("type")?.as_str()? {
        "stop" => Some(Command::Stop),
        "drain" => Some(Command::Drain),
        "refresh" => Some(Command::Refresh),
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
/* Entry-point picker                                                        */
/* ------------------------------------------------------------------------ */

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntryPoint {
    pub path: String,
    pub line: usize,
    pub surface: String,
    pub seed: String,
}

pub const ENTRY_POINT_SURFACES: [&str; 5] = [
    "scout",
    "design",
    "dead-code",
    "single-responsibility",
    "consistent-naming",
];

const SKIPPED_DIRECTORIES: [&str; 5] = [".git", "node_modules", "dist", ".worktree", ".tmp"];
const NON_COMPONENT_DIRECTORIES: [&str; 3] = ["fixtures", "tests", "stubs"];
const NON_SOURCE_EXTENSIONS: [&str; 8] = [
    ".md",
    ".markdown",
    ".txt",
    ".json",
    ".yml",
    ".yaml",
    ".toml",
    ".lock",
];
const TEXT_SAMPLE_BYTES: usize = 8192;

fn inside(root: &Path, candidate: &Path) -> bool {
    let root = absolute(root);
    let candidate = absolute(candidate);
    candidate
        .strip_prefix(&root)
        .map(|local| {
            let text = local.to_string_lossy();
            !text.starts_with("..")
        })
        .unwrap_or(false)
}

fn skipped(relative: &str) -> bool {
    let parts: Vec<&str> = relative.split('/').collect();
    if parts.iter().any(|part| SKIPPED_DIRECTORIES.contains(part)) {
        return true;
    }
    relative == ".devboard/.tmp" || relative.starts_with(".devboard/.tmp/")
}

fn byte_order(left: &str, right: &str) -> std::cmp::Ordering {
    left.as_bytes().cmp(right.as_bytes())
}

fn git_output(root: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    output.status.success().then_some(output.stdout)
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

fn git_work_tree(root: &Path) -> bool {
    let Ok(real) = std::fs::canonicalize(root) else {
        return false;
    };
    let Some(top) = git_output(root, &["rev-parse", "--show-toplevel"]) else {
        return false;
    };
    let top = String::from_utf8_lossy(&top)
        .trim_end_matches('\n')
        .to_string();
    std::fs::canonicalize(top)
        .map(|path| path == real)
        .unwrap_or(false)
}

fn regular_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
}

fn text_sample(path: &Path) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    let mut buffer = vec![0_u8; TEXT_SAMPLE_BYTES];
    let read = file.read(&mut buffer).ok()?;
    buffer.truncate(read);
    Some(buffer)
}

fn is_text_file(path: &Path) -> bool {
    let Some(bytes) = text_sample(path) else {
        return false;
    };
    if bytes.contains(&0) {
        return false;
    }
    let mut control = 0_usize;
    let mut visible = false;
    for byte in &bytes {
        if *byte < 32 && !matches!(*byte, 9 | 10 | 13) {
            control += 1;
        }
        if *byte > 32 {
            visible = true;
        }
    }
    visible && !bytes.is_empty() && (control as f64 / bytes.len() as f64) < 0.1
}

fn walk_visit(directory: &Path, prefix: &str, files: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    let mut children: Vec<(String, PathBuf, bool, bool)> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let metadata = std::fs::symlink_metadata(&path).ok()?;
            Some((
                entry.file_name().to_string_lossy().into_owned(),
                path,
                metadata.is_dir(),
                metadata.is_file(),
            ))
        })
        .collect();
    children.sort_by(|left, right| byte_order(&left.0, &right.0));
    for (name, path, is_dir, is_file) in children {
        let relative = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if skipped(&relative) {
            continue;
        }
        if is_dir {
            walk_visit(&path, &relative, files);
            continue;
        }
        if !is_file {
            continue;
        }
        files.push(relative);
    }
}

fn walk_regular_files(repo_dir: &Path) -> Vec<String> {
    let root = absolute(repo_dir);
    let mut files = Vec::new();
    walk_visit(&root, "", &mut files);
    files.sort_by(|left, right| byte_order(left, right));
    files
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
    let mut files = Vec::new();
    for path in paths {
        if skipped(&path) {
            continue;
        }
        let absolute_path = root.join(&path);
        if !inside(root, &absolute_path) || !regular_file(&absolute_path) {
            continue;
        }
        files.push(path);
    }
    files.sort_by(|left, right| byte_order(left, right));
    Some(files)
}

fn glob_match(pattern: &str, path: &str) -> bool {
    let mut regex = String::from("^");
    for character in pattern.chars() {
        match character {
            '*' => regex.push_str(".*"),
            '?' => regex.push('.'),
            other => regex.push_str(&regex::escape(&other.to_string())),
        }
    }
    regex.push('$');
    regex::Regex::new(&regex)
        .map(|compiled| compiled.is_match(path))
        .unwrap_or(false)
}

fn ignored_by_rules(root: &Path, relative: &str) -> bool {
    let Ok(text) = std::fs::read_to_string(root.join(".gitignore")) else {
        return false;
    };
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('!') {
            continue;
        }
        let pattern = line.strip_prefix('/').unwrap_or(line);
        let directory = pattern.ends_with('/');
        let pattern = pattern.trim_end_matches('/');
        let segments: Vec<&str> = relative.split('/').collect();
        for length in 1..=segments.len() {
            if directory && length == segments.len() {
                continue;
            }
            let candidate = segments[..length].join("/");
            if pattern.contains('/') {
                if glob_match(pattern, &candidate) {
                    return true;
                }
            } else if glob_match(pattern, segments[length - 1]) {
                return true;
            }
        }
    }
    false
}

/// Whether git itself excludes this path.
///
/// A tracked path is repository content even when a broad ignore rule such as
/// `/.devboard` matches its text, so the check deliberately omits
/// `--no-index`: `git check-ignore` never reports a tracked path, and a keyed
/// entry point is never refused for matching the pattern that keeps a host's
/// installed copy untracked.
fn is_ignored_path(root: &Path, relative: &str) -> bool {
    if git_work_tree(root) {
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["check-ignore", "-q", "--", relative])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        if let Ok(status) = status {
            if status.success() {
                return true;
            }
            if status.code() == Some(1) {
                return false;
            }
        }
    }
    ignored_by_rules(root, relative)
}

pub fn walk_regular_repository_files(repo_dir: &Path) -> Vec<String> {
    walk_regular_files(repo_dir)
}

pub fn scout_pool(repo_dir: &Path) -> Vec<String> {
    let root = absolute(repo_dir);
    let files = match git_admitted_files(&root) {
        Some(files) => files,
        None => walk_regular_files(&root)
            .into_iter()
            .filter(|path| !ignored_by_rules(&root, path))
            .collect(),
    };
    files
        .into_iter()
        .filter(|path| is_text_file(&root.join(path)))
        .collect()
}

fn read_head(path: &Path) -> String {
    text_sample(path)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default()
}

fn source_code_line(head: &str) -> bool {
    static CODE_LINE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(
            r"(?m)^\s*(?:import|export|from|class|def|function|const|let|var|interface|type|enum|package|use|#include|public|private|protected|func|fn|impl|module|namespace|struct|trait|async|await|return|if|for|while|switch|case)\b",
        )
        .expect("a source line pattern")
    });
    static RULE_LINE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?m)^\s*[.#@&*:a-zA-Z][^{}\n]*\{[^}\n]*$")
            .expect("a style rule pattern")
    });
    CODE_LINE.is_match(head) || RULE_LINE.is_match(head)
}

pub fn discover_source_extensions(repo_dir: &Path) -> Vec<String> {
    let root = absolute(repo_dir);
    let mut extensions: HashSet<String> = HashSet::new();
    for path in scout_pool(&root) {
        let extension = Path::new(&path)
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| format!(".{}", value.to_lowercase()))
            .unwrap_or_default();
        if extension.is_empty() || extensions.contains(&extension) {
            continue;
        }
        if source_code_line(&read_head(&root.join(&path))) {
            extensions.insert(extension);
        }
    }
    let mut extensions: Vec<String> = extensions.into_iter().collect();
    extensions.sort_by(|left, right| byte_order(left, right));
    extensions
}

pub fn dead_code_pool(repo_dir: &Path) -> Vec<String> {
    let root = absolute(repo_dir);
    let extensions: HashSet<String> = discover_source_extensions(&root).into_iter().collect();
    let mut files: Vec<String> = scout_pool(&root)
        .into_iter()
        .filter(|path| {
            let extension = Path::new(path)
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| format!(".{}", value.to_lowercase()))
                .unwrap_or_default();
            extensions.contains(&extension)
        })
        .collect();
    files.sort_by(|left, right| byte_order(left, right));
    files
}

fn is_test_file(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.contains(".test.") || name.contains(".spec.")
}

fn is_component_path(path: &str) -> bool {
    let directories = path.rsplit_once('/').map(|(head, _)| head).unwrap_or("");
    !directories
        .split('/')
        .any(|directory| NON_COMPONENT_DIRECTORIES.contains(&directory))
}

pub fn single_responsibility_pool(repo_dir: &Path) -> Vec<String> {
    let mut files: Vec<String> = dead_code_pool(repo_dir)
        .into_iter()
        .filter(|path| {
            let extension = Path::new(path)
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| format!(".{}", value.to_lowercase()))
                .unwrap_or_default();
            !is_test_file(path)
                && is_component_path(path)
                && !NON_SOURCE_EXTENSIONS.contains(&extension.as_str())
        })
        .collect();
    files.sort_by(|left, right| byte_order(left, right));
    files
}

/// The consistent-naming pool: the same component source set, because a
/// concept's name is audited in code, never in a test, a fixture, or a stub.
/// It covers every source tree the host writes, the server and the client alike.
pub fn consistent_naming_pool(repo_dir: &Path) -> Vec<String> {
    single_responsibility_pool(repo_dir)
}

pub fn eligible_files(repo_dir: &Path, surface: &str) -> Vec<String> {
    match surface {
        "scout" => scout_pool(repo_dir),
        "dead-code" => dead_code_pool(repo_dir),
        "single-responsibility" => single_responsibility_pool(repo_dir),
        "consistent-naming" => consistent_naming_pool(repo_dir),
        _ => Vec::new(),
    }
}

fn fresh_seed() -> String {
    let mut bytes = [0_u8; 16];
    for byte in &mut bytes {
        *byte = rand::random::<u8>();
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn digest(surface: &str, seed: &str) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(surface.as_bytes());
    hasher.update([0_u8]);
    hasher.update(seed.as_bytes());
    hasher.finalize().to_vec()
}

fn line_inside(text: &str, path: &str, hash: &[u8]) -> Result<usize, String> {
    let lines: Vec<&str> = if text.is_empty() {
        Vec::new()
    } else {
        text.strip_suffix('\n')
            .unwrap_or(text)
            .split('\n')
            .collect()
    };
    let candidates: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_index, line)| !line.trim().is_empty())
        .map(|(index, _line)| index)
        .collect();
    if candidates.is_empty() {
        return Err(format!(
            "the entry point {path} has no non-blank line to name"
        ));
    }
    let offset =
        u32::from_be_bytes([hash[4], hash[5], hash[6], hash[7]]) as usize % candidates.len();
    Ok(candidates[offset] + 1)
}

/// Picks one eligible file and a line inside it, deterministically.
pub fn pick_entry_point(
    repo_dir: &Path,
    surface: &str,
    seed: Option<&str>,
) -> Result<EntryPoint, String> {
    pick_entry_point_for(repo_dir, surface, seed)
}

pub fn pick_entry_point_for(
    repo_dir: &Path,
    surface: &str,
    seed: Option<&str>,
) -> Result<EntryPoint, String> {
    if !ENTRY_POINT_SURFACES.contains(&surface) {
        return Err(format!(
            "unknown entry-point surface {surface}; use one of {}",
            ENTRY_POINT_SURFACES.join(", ")
        ));
    }
    let root = absolute(repo_dir);
    let root_real = std::fs::canonicalize(&root)
        .map_err(|_| format!("the repository root {} does not exist", root.display()))?;
    let files = eligible_files(&root, surface);
    if files.is_empty() {
        return Err(format!(
            "the {surface} entry-point pool has no eligible file"
        ));
    }
    let seed = match seed {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => fresh_seed(),
    };
    let hash = digest(surface, &seed);
    let index = u32::from_be_bytes([hash[0], hash[1], hash[2], hash[3]]) as usize % files.len();
    let path = files[index].clone();
    let absolute_path = root.join(&path);
    if !inside(&root, &absolute_path) {
        return Err(format!(
            "the {surface} entry point leaves the repository: {path}"
        ));
    }
    if is_ignored_path(&root, &path) {
        return Err(format!(
            "the {surface} entry point {path} is excluded by the repository's ignore rules"
        ));
    }
    let real = std::fs::canonicalize(&absolute_path)
        .map_err(|_| format!("the {surface} entry point {path} is not readable"))?;
    if !inside(&root_real, &real) {
        return Err(format!(
            "the {surface} entry point resolves outside the repository: {path}"
        ));
    }
    let text = std::fs::read_to_string(&real)
        .map_err(|_| format!("the {surface} entry point {path} is not readable"))?;
    let line = line_inside(&text, &path, &hash)?;
    Ok(EntryPoint {
        path,
        line,
        surface: surface.to_string(),
        seed,
    })
}

/* ------------------------------------------------------------------------ */
/* One cycle's request                                                       */
/* ------------------------------------------------------------------------ */

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CycleRequest {
    pub version: i64,
    pub cycle_id: String,
    pub repository: String,
    pub repo_dir: String,
    pub surface: String,
    pub seed: String,
    pub entry_path: String,
    pub entry_line: usize,
    pub categories: Vec<String>,
    pub known_titles: Vec<String>,
    pub issue_room: i64,
    pub max_per_hour: Option<i64>,
    pub max_pending: Option<i64>,
    pub created_at: String,
}

impl CycleRequest {
    pub fn to_json(&self) -> Value {
        json!({
            "version": self.version,
            "cycleId": self.cycle_id,
            "repository": self.repository,
            "repoDir": self.repo_dir,
            "surface": self.surface,
            "seed": self.seed,
            "entryPoint": {"path": self.entry_path, "line": self.entry_line},
            "categories": self.categories,
            "knownTitles": self.known_titles,
            "issueRoom": self.issue_room,
            "maxPerHour": self.max_per_hour,
            "maxPending": self.max_pending,
            "createdAt": self.created_at,
        })
    }
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
    Err("could not allocate a unique dead-code cycle directory".to_string())
}

pub struct WriteCycleOptions<'a> {
    pub cycle_id: &'a str,
    pub repository: &'a str,
    pub repo_dir: &'a Path,
    pub known_titles: Vec<String>,
    pub issue_room: i64,
    pub max_per_hour: Option<i64>,
    pub max_pending: Option<i64>,
    pub now_millis: i64,
}

pub fn write_cycle(
    directory: &Path,
    options: WriteCycleOptions<'_>,
) -> Result<CycleRequest, String> {
    let repo_dir = absolute(options.repo_dir);
    let pick = pick_entry_point(&repo_dir, "dead-code", None)?;
    let mut known = options.known_titles;
    known.sort();
    let request = CycleRequest {
        version: CYCLE_VERSION,
        cycle_id: options.cycle_id.to_string(),
        repository: options.repository.to_string(),
        repo_dir: repo_dir.to_string_lossy().into_owned(),
        surface: pick.surface,
        seed: pick.seed,
        entry_path: pick.path,
        entry_line: pick.line,
        categories: DEAD_CODE_CATEGORIES
            .iter()
            .map(|value| value.to_string())
            .collect(),
        known_titles: known,
        issue_room: options.issue_room,
        max_per_hour: options.max_per_hour,
        max_pending: options.max_pending,
        created_at: iso_from_millis(options.now_millis),
    };
    write_atomic(&request_path(directory), &json_text(&request.to_json()))
        .map_err(|error| error.to_string())?;
    Ok(request)
}

pub fn prompt_for(directory: &Path) -> String {
    format!("/dead-code-removal {}", directory.display())
}

/* ------------------------------------------------------------------------ */
/* Forge seam                                                                */
/* ------------------------------------------------------------------------ */

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForgeIssue {
    pub number: i64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub created_at: String,
    pub closed_at: Option<String>,
    pub body: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Release {
    pub tag: String,
    pub published_at: String,
}

pub type ForgeFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;

pub trait ForgeClient: Send + Sync {
    fn list_issues(&self) -> ForgeFuture<'_, Vec<ForgeIssue>>;
    fn list_open_issue_titles(&self) -> ForgeFuture<'_, Vec<String>>;
    fn list_releases(&self) -> ForgeFuture<'_, Vec<Release>>;
    fn closing_commits(&self, issue_number: i64) -> ForgeFuture<'_, Vec<String>>;
    fn landed_commits(&self, issue_number: i64) -> Vec<String>;
    fn resolve_commit(&self, short: String) -> ForgeFuture<'_, Option<String>>;
    fn containing_release_tags(
        &self,
        commit: String,
        releases: Vec<Release>,
    ) -> ForgeFuture<'_, Vec<String>>;
}

#[derive(Clone)]
struct RealForge {
    issues: Arc<crate::forge::ForgeIssuesClient>,
    releases: ReleaseClient,
    repo_dir: PathBuf,
}

#[derive(Clone)]
enum ReleaseClient {
    GitHub(crate::forge::RepositoryGitHub),
    Gitea {
        target: crate::forge::GiteaTarget,
        transport: crate::forge::Transport,
        options: crate::forge::GiteaCallOptions,
    },
}

fn github_runner(
    exec: crate::forge::Exec,
    environment: HashMap<String, String>,
) -> crate::forge::GitHubCommandRunner {
    Arc::new(move |argv: Vec<String>, _env: HashMap<String, String>| {
        let exec = exec.clone();
        let environment = environment.clone();
        Box::pin(async move {
            let result = exec(
                "gh".to_string(),
                argv,
                crate::forge::ExecOptions {
                    env: environment,
                    ..Default::default()
                },
            )
            .await;
            crate::forge::GitHubCommandOutcome {
                code: result.code,
                stdout: result.stdout,
                stderr: result.stderr,
            }
        })
    })
}

fn git_line(repo_dir: &Path, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo_dir)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

impl RealForge {
    fn new(repo_dir: &Path) -> Result<Self, String> {
        let environment = crate::forge::process_environment();
        let remote = crate::forge::origin_forge_with(repo_dir, &environment).ok_or_else(|| {
            "the checkout's origin does not name a supported repository".to_string()
        })?;
        let options = crate::forge::ForgeIssuesOptions::new(repo_dir);
        let issues =
            crate::forge::ForgeIssuesClient::new(options).map_err(|error| error.message)?;
        let releases = match remote.forge {
            Forge::Gitea => {
                let target =
                    crate::forge::gitea_target(Some(&remote), None, None, None, &environment)
                        .map_err(|error| error.message)?;
                ReleaseClient::Gitea {
                    target,
                    transport: crate::forge::default_transport(30_000),
                    options: crate::forge::GiteaCallOptions::default(),
                }
            }
            _ => {
                let run = github_runner(crate::forge::default_exec(), environment.clone());
                ReleaseClient::GitHub(crate::forge::RepositoryGitHub::new(
                    crate::forge::RepositoryGitHubOptions {
                        repository: remote.project,
                        repo_dir: repo_dir.to_path_buf(),
                        run,
                        environment,
                    },
                ))
            }
        };
        Ok(Self {
            issues: Arc::new(issues),
            releases,
            repo_dir: absolute(repo_dir),
        })
    }
}

impl ReleaseClient {
    async fn list(&self) -> Result<Vec<Release>, String> {
        match self {
            Self::GitHub(client) => Ok(client
                .list_releases()
                .await?
                .into_iter()
                .map(|release| Release {
                    tag: release.tag,
                    published_at: release.published_at,
                })
                .collect()),
            Self::Gitea {
                target,
                transport,
                options,
            } => Ok(
                crate::forge::gitea_list_releases(target, transport, options)
                    .await
                    .map_err(|error| error.message)?
                    .into_iter()
                    .map(|release| Release {
                        tag: release.tag,
                        published_at: release.published_at,
                    })
                    .collect(),
            ),
        }
    }

    async fn closing_commits(&self, issue_number: i64) -> Result<Vec<String>, String> {
        match self {
            Self::GitHub(client) => client.closing_commits(issue_number).await,
            Self::Gitea {
                target,
                transport,
                options,
            } => crate::forge::gitea_closing_commits(target, issue_number, transport, options)
                .await
                .map_err(|error| error.message),
        }
    }

    async fn resolve_commit(&self, repo_dir: &Path, short: &str) -> Option<String> {
        match self {
            Self::GitHub(client) => client.resolve_commit(short).await.ok().flatten(),
            Self::Gitea { .. } => git_line(
                repo_dir,
                &["rev-parse", "--verify", &format!("{short}^{{commit}}")],
            ),
        }
    }

    async fn containing_tags(
        &self,
        repo_dir: &Path,
        commit: &str,
        releases: &[Release],
    ) -> Vec<String> {
        match self {
            Self::GitHub(client) => {
                let releases: Vec<crate::forge::GitHubRelease> = releases
                    .iter()
                    .map(|release| crate::forge::GitHubRelease {
                        tag: release.tag.clone(),
                        published_at: release.published_at.clone(),
                    })
                    .collect();
                client
                    .containing_release_tags(commit, &releases)
                    .await
                    .unwrap_or_default()
            }
            Self::Gitea { .. } => git_line(repo_dir, &["tag", "--contains", commit])
                .map(|text| text.lines().map(str::to_string).collect())
                .unwrap_or_default(),
        }
    }
}

impl ForgeClient for RealForge {
    fn list_issues(&self) -> ForgeFuture<'_, Vec<ForgeIssue>> {
        let client = Arc::clone(&self.issues);
        Box::pin(async move {
            let documents = client
                .list_labelled(crate::forge::IssueQueryState::All, DEAD_CODE_LABEL)
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
                    closed_at: None,
                    body: document.body,
                });
            }
            Ok(issues)
        })
    }

    fn list_open_issue_titles(&self) -> ForgeFuture<'_, Vec<String>> {
        let client = Arc::clone(&self.issues);
        Box::pin(async move {
            let rows = client
                .list(crate::forge::IssueQueryState::Open, Some(1000))
                .await
                .map_err(|error| error.message)?;
            Ok(rows.into_iter().map(|row| row.title).collect())
        })
    }

    fn list_releases(&self) -> ForgeFuture<'_, Vec<Release>> {
        let releases = self.releases.clone();
        Box::pin(async move { releases.list().await })
    }

    fn closing_commits(&self, issue_number: i64) -> ForgeFuture<'_, Vec<String>> {
        let releases = self.releases.clone();
        Box::pin(async move { releases.closing_commits(issue_number).await })
    }

    fn landed_commits(&self, issue_number: i64) -> Vec<String> {
        crate::forge::landed_commits(&self.repo_dir, issue_number)
    }

    fn resolve_commit(&self, short: String) -> ForgeFuture<'_, Option<String>> {
        let releases = self.releases.clone();
        let repo_dir = self.repo_dir.clone();
        Box::pin(async move { Ok(releases.resolve_commit(&repo_dir, &short).await) })
    }

    fn containing_release_tags(
        &self,
        commit: String,
        releases: Vec<Release>,
    ) -> ForgeFuture<'_, Vec<String>> {
        let client = self.releases.clone();
        let repo_dir = self.repo_dir.clone();
        Box::pin(async move { Ok(client.containing_tags(&repo_dir, &commit, &releases).await) })
    }
}

pub fn create_forge(repo_dir: &Path) -> Result<Arc<dyn ForgeClient>, String> {
    Ok(Arc::new(RealForge::new(repo_dir)?))
}

/// The earliest published release containing any of the tags.
pub fn earliest_release(releases: &[Release], tags: &[String]) -> Option<String> {
    let mut candidates: Vec<&Release> = releases
        .iter()
        .filter(|release| tags.iter().any(|tag| tag == &release.tag))
        .collect();
    candidates.sort_by(|left, right| {
        parse_iso_millis(&left.published_at)
            .unwrap_or(0)
            .cmp(&parse_iso_millis(&right.published_at).unwrap_or(0))
            .then_with(|| left.tag.cmp(&right.tag))
    });
    candidates.first().map(|release| release.tag.clone())
}

fn release_at_close(releases: &[Release], issue: &ForgeIssue) -> Option<String> {
    let closed = issue.closed_at.as_deref().and_then(parse_iso_millis)?;
    let filed = parse_iso_millis(&issue.created_at);
    let mut candidates: Vec<(&Release, i64)> = releases
        .iter()
        .filter_map(|release| {
            let at = parse_iso_millis(&release.published_at)?;
            if filed.is_some_and(|filed| at < filed) {
                return None;
            }
            Some((release, at))
        })
        .collect();
    candidates.sort_by(|left, right| {
        left.1
            .cmp(&right.1)
            .then_with(|| left.0.tag.cmp(&right.0.tag))
    });
    candidates
        .iter()
        .filter(|(_release, at)| *at <= closed)
        .next_back()
        .or_else(|| candidates.first())
        .map(|(release, _at)| release.tag.clone())
}

/// The release that shipped the issue's closing commit, with every failure
/// reported rather than thrown.
pub async fn resolve_shipped_version(
    issue: &ForgeIssue,
    forge: &dyn ForgeClient,
    releases: &[Release],
) -> (Option<String>, Option<String>) {
    if issue.state != "closed" {
        return (None, None);
    }
    let nearest = release_at_close(releases, issue);
    let without_commit = |error: String| match &nearest {
        Some(version) => (Some(version.clone()), None),
        None => (None, Some(error)),
    };
    let landed = forge.landed_commits(issue.number);
    if !landed.is_empty() {
        let mut tags: HashSet<String> = HashSet::new();
        let mut resolved: Option<String> = None;
        for candidate in landed {
            let Some(commit) = forge.resolve_commit(candidate).await.ok().flatten() else {
                continue;
            };
            if resolved.is_none() {
                resolved = Some(commit.clone());
            }
            for tag in forge
                .containing_release_tags(commit, releases.to_vec())
                .await
                .unwrap_or_default()
            {
                tags.insert(tag);
            }
        }
        if let Some(resolved) = resolved {
            let tags: Vec<String> = tags.into_iter().collect();
            return match earliest_release(releases, &tags) {
                Some(version) => (Some(version), None),
                None => (
                    None,
                    Some(format!("no published release contains {resolved}")),
                ),
            };
        }
    }
    let candidates = match forge.closing_commits(issue.number).await {
        Ok(candidates) => candidates,
        Err(error) => return (None, Some(error)),
    };
    if candidates.is_empty() {
        return without_commit("no closing commit was found".to_string());
    }
    let mut error = format!(
        "closing commit {} could not be resolved",
        candidates.first().cloned().unwrap_or_default()
    );
    let mut resolved: Option<String> = None;
    for candidate in candidates {
        let Some(commit) = forge.resolve_commit(candidate).await.ok().flatten() else {
            continue;
        };
        resolved = Some(commit.clone());
        let tags = forge
            .containing_release_tags(commit.clone(), releases.to_vec())
            .await
            .unwrap_or_default();
        if let Some(version) = earliest_release(releases, &tags) {
            return (Some(version), None);
        }
        error = format!("no published release contains {commit}");
    }
    match resolved {
        None => without_commit(error),
        Some(_) => (None, Some(error)),
    }
}

/* ------------------------------------------------------------------------ */
/* The worker                                                                */
/* ------------------------------------------------------------------------ */

struct ActiveCycle {
    cycle_id: String,
    directory: PathBuf,
    activity: Vec<String>,
    peer: Arc<dyn Peer>,
    heartbeat: Arc<CycleHeartbeat>,
    first_line: Option<String>,
    finished: bool,
    requested: i64,
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
    manual_cycles: bool,
    log: Arc<dyn Fn(String) + Send + Sync>,
    inner: Mutex<Inner>,
    settled: tokio::sync::Notify,
    weak: Weak<Worker>,
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
        let previous = load_state(&self.versioned_state_path())
            .or_else(|| load_state(&state_path(&self.state_dir, &self.repo_dir)));
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
            state.release_signature = previous.release_signature;
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
        let last = lock(&self.inner).state.last_cycle_started_at.clone();
        let Some(started) = last.as_deref().and_then(parse_iso_millis) else {
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
        let stale = {
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
            true
        };
        if stale {
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
                {
                    let mut inner = lock(&self.inner);
                    inner.draining = true;
                    inner.state.draining = true;
                    inner.state.last_error = None;
                    inner.state.notice =
                        Some("Draining: this worker exits after its in-flight cycle.".to_string());
                }
                self.publish();
            }
            Command::Refresh => self.refresh().await,
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
                        "Dead Code settings must be 1 through 1440 minutes and nullable 1..100 caps.",
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
                    inner.state.notice = Some(format!(
                        "Settings saved: every {interval_minutes} minute(s), {} per hour, {} open.",
                        limit_label(max_per_hour),
                        limit_label(max_pending)
                    ));
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

    async fn read_forge(&self) -> Result<(Vec<ForgeIssue>, Vec<Release>, Vec<String>), String> {
        let forge = lock(&self.inner).forge.clone();
        let Some(forge) = forge else {
            return Err("no forge client is configured".to_string());
        };
        let (issues, releases, open_titles) = tokio::join!(
            forge.list_issues(),
            forge.list_releases(),
            forge.list_open_issue_titles()
        );
        Ok((issues?, releases?, open_titles?))
    }

    async fn read_forge_within_deadline(
        &self,
    ) -> Result<(Vec<ForgeIssue>, Vec<Release>, Vec<String>), String> {
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
        match self.read_forge_within_deadline().await {
            Err(detail) => self.record_sync_failure(&detail),
            Ok((issues, releases, open_titles)) => {
                self.apply_read(issues, releases, open_titles).await;
                lock(&self.inner).retry.succeed();
                lock(&self.inner).next_sync_at = self.now() + self.sync_ms as i64;
                self.publish();
            }
        }
        lock(&self.inner).syncing = false;
    }

    async fn apply_read(
        &self,
        issues: Vec<ForgeIssue>,
        releases: Vec<Release>,
        open_titles: Vec<String>,
    ) {
        let (previous, forge) = {
            let inner = lock(&self.inner);
            (inner.state.issues.clone(), inner.forge.clone())
        };
        let previous: HashMap<i64, IssueRow> =
            previous.into_iter().map(|row| (row.number, row)).collect();
        let mut ordered: Vec<&Release> = releases.iter().collect();
        ordered.sort_by(|left, right| left.tag.cmp(&right.tag));
        let signature = ordered
            .iter()
            .map(|release| format!("{}@{}", release.tag, release.published_at))
            .collect::<Vec<_>>()
            .join("\n");
        let releases_changed =
            Some(signature.clone()) != lock(&self.inner).state.release_signature.clone();
        let now = self.now();
        let mut rows: Vec<IssueRow> = Vec::new();
        for issue in issues {
            let before = previous.get(&issue.number);
            let state = if issue.state == "closed" {
                IssueState::Implemented
            } else {
                IssueState::Pending
            };
            let category = before
                .and_then(|row| row.category.clone())
                .or_else(|| category_from_body(&issue.body));
            let mut row = IssueRow {
                number: issue.number,
                title: issue.title.clone(),
                url: issue.url.clone(),
                created_at: issue.created_at.clone(),
                state,
                category,
                version: if state == IssueState::Implemented {
                    before.and_then(|row| row.version.clone())
                } else {
                    None
                },
                version_attempt_at: if state == IssueState::Implemented {
                    before.and_then(|row| row.version_attempt_at.clone())
                } else {
                    None
                },
                version_error: if state == IssueState::Implemented {
                    before.and_then(|row| row.version_error.clone())
                } else {
                    None
                },
            };
            rows.push(row.clone());
            if row.state != IssueState::Implemented || row.version.is_some() {
                continue;
            }
            let Some(forge) = forge.clone() else {
                continue;
            };
            let attempt = row
                .version_attempt_at
                .as_deref()
                .and_then(parse_iso_millis)
                .unwrap_or(0);
            if !releases_changed && now - attempt < RESOLUTION_RETRY_MS {
                continue;
            }
            let (version, error) = resolve_shipped_version(&issue, forge.as_ref(), &releases).await;
            row.version_attempt_at = Some(iso_from_millis(self.now()));
            row.version_error = error;
            if let Some(version) = version {
                row.version = Some(version);
                row.version_error = None;
            }
            if let Some(last) = rows.last_mut() {
                *last = row;
            }
        }
        rows.sort_by(newest_first);
        {
            let mut inner = lock(&self.inner);
            inner.state.issues = rows;
            inner.state.release_signature = Some(signature);
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
            let delay = lock(&self.inner).retry.record(kind);
            if let Some(delay) = delay {
                {
                    let mut inner = lock(&self.inner);
                    let at = inner.state.sync.at.clone();
                    inner.state.sync = SyncStatus {
                        state: SyncState::Stale,
                        at,
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
        if lock(&self.inner).stopping || !lock(&self.inner).state.enabled {
            return;
        }
        if lock(&self.inner).draining {
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

    pub async fn run_once(&self) {
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

    pub async fn begin_cycle(&self) {
        {
            let inner = lock(&self.inner);
            if inner.stopping
                || inner.draining
                || inner.active.is_some()
                || inner.cycling
                || !inner.state.enabled
            {
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
        known_titles.extend(read_draft_goal_headings(&self.repo_dir));
        let (repository, max_per_hour, max_pending) = {
            let inner = lock(&self.inner);
            (
                inner.state.repo.clone(),
                inner.state.limits.max_per_hour,
                inner.state.limits.max_pending,
            )
        };
        let requested = capacity.batch;
        let request = match write_cycle(
            &directory,
            WriteCycleOptions {
                cycle_id: &cycle_id,
                repository: &repository,
                repo_dir: &self.repo_dir,
                known_titles,
                issue_room: requested,
                max_per_hour,
                max_pending,
                now_millis: now,
            },
        ) {
            Ok(request) => request,
            Err(detail) => {
                self.settle_with_failure(&detail, now);
                return;
            }
        };
        let prompt = prompt_for(&directory);
        let mut activity = vec![format!(
            "entry point {}:{} (seed {})",
            request.entry_path, request.entry_line, request.seed
        )];
        let cycle_line = format!(
            "cycle {cycle_id}: surface {}, room {requested}, caps {}/{}",
            request.surface,
            limit_label(max_per_hour),
            limit_label(max_pending)
        );
        activity.push(cycle_line);
        if requested == 0 {
            activity.push("no filing room this cycle; nothing will be filed".to_string());
        }
        let _ = write_activity(&directory, &activity);
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
            directory,
            activity,
            peer,
            heartbeat,
            first_line: None,
            finished: false,
            requested,
        };
        {
            let mut inner = lock(&self.inner);
            inner.active = Some(active);
            inner.state.newest_cycle_id = Some(cycle_id.clone());
            inner.state.lifecycle = Lifecycle::Detecting;
            inner.state.last_error = None;
            inner.state.next_attempt_at = None;
            inner.starting = false;
        }
        self.publish();
        self.spawn_cycle(cycle_id, prompt);
    }

    fn callbacks_for(&self, cycle_id: &str, heartbeat: Arc<CycleHeartbeat>) -> PeerCallbacks {
        let Some(worker) = self.weak.upgrade() else {
            return PeerCallbacks::default();
        };
        let activity_id = cycle_id.to_string();
        let stderr_id = cycle_id.to_string();
        let stderr_worker = self.weak.upgrade();
        let heartbeat_for_activity = Arc::clone(&heartbeat);
        let heartbeat_for_update = Arc::clone(&heartbeat);
        PeerCallbacks {
            on_activity: Some(Arc::new(move |entry: AcpActivity| {
                heartbeat_for_activity.beat();
                worker.record_activity(&activity_id, entry);
            })),
            on_stderr: stderr_worker.map(|worker| {
                Arc::new(move |text: String| worker.record_stderr(&stderr_id, &text))
                    as Arc<dyn Fn(String) + Send + Sync>
            }),
            on_session_update: Some(Arc::new(move || heartbeat_for_update.beat())),
        }
    }

    fn spawn_cycle(&self, cycle_id: String, prompt: String) {
        let Some(worker) = self.weak.upgrade() else {
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
            inner.state.notice = Some(format!("Dead-code cycle failed: {detail}"));
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
            if let Some(worker) = self.weak.upgrade() {
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
            inner.active.as_mut().map(|active| {
                active.finished = true;
                (
                    active.directory.clone(),
                    Arc::clone(&active.peer),
                    active.requested,
                )
            })
        };
        let Some((directory, peer, requested)) = active else {
            return;
        };
        peer.close();
        let mut error: Option<String> = None;
        let record = |text: String| self.record_activity_line(cycle_id, &text);
        let mut filed_now = 0_i64;
        let log_path = directory.join("tool-log.jsonl");
        for entry in super::mcp_optimizer::read_tool_log(&log_path) {
            if entry.get("tool").and_then(Value::as_str) != Some("issue_create") {
                continue;
            }
            let number = tool_value_number(entry.get("value"), "number");
            let title = tool_value_string(entry.get("value"), "title");
            if entry.get("ok").and_then(Value::as_bool) == Some(true)
                && number.is_some()
                && title.is_some()
            {
                if filed_now >= requested {
                    record(format!(
                        "filed beyond the requested count: #{}",
                        number.unwrap_or(0)
                    ));
                    continue;
                }
                filed_now += 1;
                record(format!(
                    "filed #{} “{}”",
                    number.unwrap_or(0),
                    title.unwrap_or_default()
                ));
                continue;
            }
            let detail = entry
                .get("error")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .unwrap_or("the issue-creation tool failed")
                .to_string();
            if error.is_none() {
                error = Some(detail.clone());
            }
            record(format!("failed: {detail}"));
        }
        if filed_now > 0 || !lock(&self.inner).state.issues.is_empty() {
            match self.read_forge_within_deadline().await {
                Ok((issues, releases, open_titles)) => {
                    self.apply_read(issues, releases, open_titles).await;
                }
                Err(failure) => record(format!("could not re-read the forge: {failure}")),
            }
        }
        if let Some(error) = &error {
            record(format!("filing stopped: {error}"));
        }
        self.finish_cycle(cycle_id, error);
    }

    fn fail_cycle(&self, cycle_id: &str, detail: &str) {
        let (_directory, first_line) = {
            let mut inner = lock(&self.inner);
            let Some(active) = inner.active.as_mut() else {
                return;
            };
            if active.cycle_id != cycle_id || active.finished {
                return;
            }
            active.finished = true;
            let first = active.first_line.clone();
            Arc::clone(&active.peer).close();
            (active.directory.clone(), first)
        };
        let error = first_line.unwrap_or_else(|| detail.to_string());
        self.record_activity_line(cycle_id, &format!("failed: {error}"));
        self.finish_cycle(cycle_id, Some(error));
    }

    fn finish_cycle(&self, cycle_id: &str, error: Option<String>) {
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
                inner.state.notice = Some(format!("Dead-code cycle failed: {error}"));
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
            if let Some(worker) = self.weak.upgrade() {
                tokio::spawn(async move {
                    worker.stop().await;
                });
            }
        }
    }

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

    fn record_activity(&self, cycle_id: &str, entry: AcpActivity) {
        let activity = {
            let mut inner = lock(&self.inner);
            inner.active.as_mut().and_then(|active| {
                if active.cycle_id != cycle_id || active.finished {
                    return None;
                }
                let text = if entry.text.chars().count() > MAX_ACTIVITY_LINE {
                    let mut bounded: String =
                        entry.text.chars().take(MAX_ACTIVITY_LINE - 1).collect();
                    bounded.push('…');
                    bounded
                } else {
                    entry.text
                };
                append_activity_line(&mut active.activity, &text, entry.append);
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

fn newest_first(left: &IssueRow, right: &IssueRow) -> std::cmp::Ordering {
    match (
        parse_iso_millis(&left.created_at),
        parse_iso_millis(&right.created_at),
    ) {
        (Some(left_at), Some(right_at)) if left_at != right_at => right_at.cmp(&left_at),
        _ => right.number.cmp(&left.number),
    }
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
    value?
        .as_object()?
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

/// The `# heading` of every draft under `.devboard/goal-proposals/`.
pub fn read_draft_goal_headings(repo_dir: &Path) -> Vec<String> {
    let directory = absolute(repo_dir).join(".devboard").join("goal-proposals");
    let Ok(entries) = std::fs::read_dir(&directory) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".md"))
        .collect();
    names.sort();
    let mut headings = Vec::new();
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

/* ------------------------------------------------------------------------ */
/* CLI                                                                       */
/* ------------------------------------------------------------------------ */

fn parse_arguments(invocation: &WorkerInvocation) -> Option<(PathBuf, PathBuf, Option<u64>)> {
    let repo_dir =
        (!invocation.repo_dir.as_os_str().is_empty()).then(|| invocation.repo_dir.clone())?;
    let state_dir =
        (!invocation.state_dir.as_os_str().is_empty()).then(|| invocation.state_dir.clone())?;
    let mut sync_ms = None;
    let mut index = 0;
    while index < invocation.rest.len() {
        if invocation.rest[index] == "--sync" {
            let value = invocation.rest.get(index + 1)?;
            index += 2;
            match value.parse::<u64>() {
                Ok(parsed) if parsed >= 1000 => sync_ms = Some(parsed),
                Ok(_) => {}
                Err(_) => return None,
            }
            continue;
        }
        index += 1;
    }
    Some((absolute(&repo_dir), absolute(&state_dir), sync_ms))
}

fn environment_millis(name: &str, minimum: u64) -> Option<u64> {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value >= minimum)
}

/// Runs one Dead Code worker until Stop or drain.
pub async fn run(invocation: &WorkerInvocation) -> anyhow::Result<()> {
    let Some((repo_dir, state_dir, sync_ms)) = parse_arguments(invocation) else {
        eprintln!("usage: worker.ts --repo <checkout> --state-dir <dir> [--sync <ms>]");
        std::process::exit(2);
    };
    let environment = crate::forge::process_environment();
    let repository =
        crate::forge::origin_repository_with(&repo_dir, &environment).unwrap_or_default();
    if repository.is_empty() {
        eprintln!("dead-code worker: the checkout's origin does not name a repository");
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
            "dead-code worker: this checkout already has a live dead-code agent for this version"
        );
        std::process::exit(0);
    }
    let sync_ms = sync_ms.or_else(|| environment_millis("DEAD_CODE_SYNC_MS", 1000));
    let cadence_ms = environment_millis("DEAD_CODE_CADENCE_MS", 100);
    let mut options = WorkerOptions::new(&repo_dir, &state_dir);
    options.harness_version = harness_version;
    options.sync_ms = sync_ms;
    options.cadence_ms = cadence_ms;
    options.log = Some(Arc::new(|line: String| eprintln!("dead-code: {line}")));
    let worker = Worker::new(options);
    if !worker.start(&repository) {
        std::process::exit(0);
    }
    let mut ticker = tokio::time::interval(Duration::from_millis(worker.tick_ms()));
    loop {
        tokio::select! {
            _ = ticker.tick() => {
                worker.run_once().await;
            }
            _ = shutdown_signal() => {
                eprintln!("dead-code: received a shutdown signal");
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

pub struct PreflightOptions {
    pub repo_dir: PathBuf,
    pub state_dir: PathBuf,
    pub environment: HashMap<String, String>,
    pub origin: Option<ForgeRemote>,
    pub run: Option<Arc<RunFn>>,
    pub gitea_transport: Option<crate::forge::Transport>,
}

pub type RunFuture = Pin<Box<dyn Future<Output = crate::forge::ExecResult> + Send>>;
pub type RunFn = dyn Fn(Vec<String>) -> RunFuture + Send + Sync;

impl Default for PreflightOptions {
    fn default() -> Self {
        Self {
            repo_dir: PathBuf::new(),
            state_dir: PathBuf::new(),
            environment: crate::forge::process_environment(),
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

fn home_directory(environment: &HashMap<String, String>) -> PathBuf {
    environment
        .get("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_default()
}

/// The installed `/dead-code-removal` command: checkout first, then the home.
pub fn dead_code_command_paths(
    repo_dir: &Path,
    environment: &HashMap<String, String>,
) -> Vec<PathBuf> {
    let home = home_directory(environment);
    vec![
        absolute(repo_dir)
            .join(".omp")
            .join("commands")
            .join("dead-code-removal.md"),
        home.join(".omp")
            .join("commands")
            .join("dead-code-removal.md"),
        home.join(".omp")
            .join("agent")
            .join("commands")
            .join("dead-code-removal.md"),
    ]
}

/// Everything Start proves before it spawns the Dead Code worker.
pub async fn preflight_dead_code(options: &PreflightOptions) -> Result<String, String> {
    let environment = &options.environment;
    let root = absolute(&options.repo_dir);
    if let Some(problem) = crate::forge::root_problem(&root) {
        return Err(problem);
    }
    if !inside(&options.repo_dir, &options.state_dir) {
        return Err(format!(
            "STATE_DIR {} is not inside REPO_DIR {}; the dead-code worker keeps its state beside the checkout",
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
            "the dead-code agent supports a GitHub or Gitea origin, not a GitLab one: {}",
            remote.host
        ));
    }
    let repository = remote.project.clone();
    if crate::forge::find_on_path("omp", environment).is_none() {
        return Err("missing prerequisite: omp is not on PATH".to_string());
    }
    if remote.forge == Forge::GitHub && crate::forge::find_on_path("gh", environment).is_none() {
        return Err("missing prerequisite: gh is not on PATH".to_string());
    }
    let command_paths = dead_code_command_paths(&root, environment);
    if !command_paths.iter().any(|path| path.exists()) {
        let looked = command_paths
            .iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "missing prerequisite: the /dead-code-removal command is not installed for omp \
             (looked in {looked})"
        ));
    }
    if remote.forge == Forge::Gitea {
        return preflight_gitea(options, &remote, &repository).await;
    }
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
        format!("repos/{repository}/labels/{DEAD_CODE_LABEL}"),
        "--jq".to_string(),
        ".name".to_string(),
    ])
    .await;
    if label.code != 0 || label.stdout.trim() != DEAD_CODE_LABEL {
        let created = run(vec![
            "label".to_string(),
            "create".to_string(),
            DEAD_CODE_LABEL.to_string(),
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
                "missing prerequisite: the \"{DEAD_CODE_LABEL}\" label could not be created in {repository}: {}",
                first_line(&created.stderr)
                    .unwrap_or_else(|| format!("gh exited with code {}", created.code))
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
    if !labels.iter().any(|label| label.name == DEAD_CODE_LABEL) {
        match crate::forge::gitea_create_label(
            &target,
            DEAD_CODE_LABEL,
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
                    .map(|labels| labels.iter().any(|label| label.name == DEAD_CODE_LABEL))
                    .unwrap_or(false);
                if !present {
                    return Err(format!(
                        "missing prerequisite: the \"{DEAD_CODE_LABEL}\" label could not be created in {repository}: {}",
                        error.message
                    ));
                }
            }
        }
    }
    Ok(repository.to_string())
}
