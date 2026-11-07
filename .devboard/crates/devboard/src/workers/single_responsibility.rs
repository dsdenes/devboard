//! The detached Single Responsibility worker.
//!
//! One worker per repository and harness version audits the host's components
//! against the project's SRP skill, one cycle at a time. The agent files each
//! proven violation through the Devboard MCP issue tool; the worker publishes
//! only the filings it reads back with the skill's provenance intact. It never
//! writes the checkout.
//!
//! Durable surface: `<STATE_DIR>/single-responsibility/<repo key>/` carries the
//! versioned and legacy state, settings, and control channel; the checkout's
//! `.devboard/.tmp/single-responsibility/` carries the repository lock, the
//! cross-version cycle lease, and one directory per cycle.

use std::collections::HashMap;
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
use crate::workers::startup::{inherited_state_path, versioned_state_files};

use super::api_standards::run_peer_until_idle;
use super::api_standards::{
    absolute, append_activity_line, default_connect, iso_from_millis, json_text, parse_iso_millis,
    write_activity, write_atomic, Clock, ConnectFn, CycleHeartbeat, Peer, PeerCallbacks,
    PeerOptions,
};
use super::dead_code::{pick_entry_point_for, read_draft_goal_headings};
use super::mcp_optimizer::now_iso;
use super::watchdog::{
    acquire_lock, claim_cycle, live_lock_owner, live_lock_owners, versioned_lock_path, ClaimHandle,
    LockDetails, LockHandle, LockResult,
};
use super::WorkerInvocation;

/* ------------------------------------------------------------------------ */
/* Constants and paths                                                       */
/* ------------------------------------------------------------------------ */

pub const SINGLE_RESPONSIBILITY_DIRECTORY: &str = "single-responsibility";
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

pub const SINGLE_RESPONSIBILITY_LABEL: &str = "single-responsibility";
pub const LABEL_COLOR: &str = "0e8a16";
pub const LABEL_DESCRIPTION: &str =
    "Single Responsibility violation proved against the project SRP skill";
pub const SINGLE_RESPONSIBILITY_CATEGORIES: [&str; 5] = [
    "mixed-responsibilities",
    "divergent-change",
    "accidental-aggregation",
    "responsibility-leakage",
    "artificial-fragmentation",
];

pub const DEFAULT_SKILL_DIRECTORY: &str = ".omp/skills/devboard-single-responsibility-principle";
pub const SKILL_FILE: &str = "SKILL.md";

pub const TICK_MS: u64 = 100;
pub const DEFAULT_AGENT_COMMAND: &str = "omp acp";
pub const FIRST_LINE_MAX: usize = 400;
pub const MAX_ACTIVITY_LINE: usize = 2000;
pub const READ_TIMEOUT_MS: u64 = 30_000;
pub const CYCLE_TIMEOUT_MS: u64 = 20 * 60_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    pub skill_dir: String,
    pub skill_document: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            skill_dir: DEFAULT_SKILL_DIRECTORY.to_string(),
            skill_document: format!("{DEFAULT_SKILL_DIRECTORY}/{SKILL_FILE}"),
        }
    }
}

pub fn single_responsibility_config() -> Config {
    Config::default()
}

pub fn single_responsibility_root(state_dir: &Path) -> PathBuf {
    state_dir.join(SINGLE_RESPONSIBILITY_DIRECTORY)
}

pub fn repo_state_directory(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    single_responsibility_root(state_dir).join(journal_key(&absolute(repo_dir)))
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
        .join(SINGLE_RESPONSIBILITY_DIRECTORY)
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
/* Provenance                                                                */
/* ------------------------------------------------------------------------ */

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillDirectives {
    pub path: String,
    pub directives: HashMap<String, String>,
}

const CATEGORY_TITLES: [(&str, &str); 5] = [
    ("mixed responsibilities", "mixed-responsibilities"),
    ("divergent change", "divergent-change"),
    ("accidental aggregation", "accidental-aggregation"),
    ("responsibility leakage", "responsibility-leakage"),
    ("artificial fragmentation", "artificial-fragmentation"),
];

fn path_inside(root: &Path, candidate: &Path) -> bool {
    let root = absolute(root);
    let candidate = absolute(candidate);
    candidate
        .strip_prefix(&root)
        .map(|local| {
            let text = local.to_string_lossy();
            text.is_empty() || (!text.starts_with("..") && !Path::new(&*text).is_absolute())
        })
        .unwrap_or(false)
}

/// Reads the skill's `## Architectural Violations` bullets.
pub fn read_skill_directives(repo_dir: &Path, skill_path: &str) -> Result<SkillDirectives, String> {
    let root = absolute(repo_dir);
    let normalized = skill_path.replace('\\', "/");
    if Path::new(&normalized).is_absolute() || !path_inside(&root, &root.join(&normalized)) {
        return Err(format!("{skill_path} resolves outside the repository"));
    }
    let text = std::fs::read_to_string(root.join(&normalized))
        .map_err(|_| format!("{skill_path} is not readable"))?;
    if text.trim().is_empty() {
        return Err(format!("{skill_path} is empty"));
    }
    let mut directives: HashMap<String, String> = HashMap::new();
    let mut in_violations = false;
    for line in text.split('\n') {
        if let Some(heading) = line.strip_prefix("## ") {
            in_violations = heading
                .trim()
                .eq_ignore_ascii_case("architectural violations");
            continue;
        }
        if !in_violations {
            continue;
        }
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix("- **") else {
            continue;
        };
        let Some(close) = rest.find(":**") else {
            continue;
        };
        let label = rest[..close].trim().to_lowercase();
        let Some((_title, category)) = CATEGORY_TITLES
            .iter()
            .find(|(title, _category)| *title == label)
        else {
            continue;
        };
        directives.insert((*category).to_string(), trimmed.to_string());
    }
    for category in SINGLE_RESPONSIBILITY_CATEGORIES {
        if !directives.contains_key(category) {
            return Err(format!(
                "{skill_path} publishes no Architectural Violations bullet for {category}"
            ));
        }
    }
    Ok(SkillDirectives {
        path: normalized,
        directives,
    })
}

const EXCLUDED_SEGMENTS: [&str; 4] = [".git", "node_modules", "dist", ".worktree"];

fn crawlable(relative: &str) -> bool {
    let parts: Vec<&str> = relative.split('/').collect();
    !parts.iter().any(|part| EXCLUDED_SEGMENTS.contains(part))
        && relative != ".devboard/.tmp"
        && !relative.starts_with(".devboard/.tmp/")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FilingProvenance {
    pub title: String,
    pub body: String,
    pub labels: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProvenanceResult {
    Ok(String),
    Problem(String),
}

fn section(body: &str, heading: &str) -> Option<String> {
    let lines: Vec<&str> = body.split('\n').collect();
    let start = lines
        .iter()
        .position(|line| line.trim().to_lowercase() == format!("## {heading}").to_lowercase())?;
    let mut content = Vec::new();
    for line in lines.iter().skip(start + 1) {
        if line.trim().starts_with("## ") {
            break;
        }
        content.push(*line);
    }
    Some(content.join("\n").trim().to_string())
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

struct EvidenceEntry {
    path: String,
    lines: String,
    quote: String,
}

fn evidence_entries(body: &str) -> Vec<EvidenceEntry> {
    let lines: Vec<&str> = body.split('\n').collect();
    let mut entries = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if !trimmed.starts_with("- `") || !trimmed.ends_with('`') {
            continue;
        }
        let location = trimmed["- `".len()..trimmed.len() - 1].trim();
        let Some((path, lines_text)) = location.rsplit_once(':') else {
            continue;
        };
        if line_span(lines_text).is_none() {
            continue;
        }
        let mut quote = String::new();
        for candidate in lines.iter().skip(index + 1) {
            if candidate.trim().is_empty() {
                continue;
            }
            if let Some(rest) = candidate.trim().strip_prefix('>') {
                quote = rest.trim().to_string();
            }
            break;
        }
        entries.push(EvidenceEntry {
            path: path.trim().to_string(),
            lines: lines_text.to_string(),
            quote,
        });
    }
    entries
}

fn prove_evidence(repo_dir: &Path, entry: &EvidenceEntry) -> Option<String> {
    let path = entry.path.replace('\\', "/");
    if path.is_empty() || Path::new(&path).is_absolute() || path.starts_with("../") {
        return Some(format!(
            "evidence path {} is not repository-relative",
            entry.path
        ));
    }
    if !crawlable(&path) {
        return Some(format!("evidence path {path} is outside the crawl region"));
    }
    let root = absolute(repo_dir);
    let absolute_path = root.join(&path);
    if !path_inside(&root, &absolute_path) {
        return Some(format!("evidence path {path} leaves the repository"));
    }
    let metadata = match std::fs::symlink_metadata(&absolute_path) {
        Ok(metadata) => metadata,
        Err(_) => return Some(format!("evidence path {path} does not exist")),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Some(format!("evidence path {path} is not a regular file"));
    }
    let Some((start, end)) = line_span(&entry.lines) else {
        return Some(format!("evidence path {path} names no line range"));
    };
    if entry.quote.is_empty() {
        return Some(format!("evidence path {path} carries no quote"));
    }
    let Ok(text) = std::fs::read_to_string(&absolute_path) else {
        return Some(format!("evidence path {path} is not readable"));
    };
    let lines: Vec<&str> = text.split('\n').collect();
    if end > lines.len() {
        return Some(format!(
            "evidence path {path}:{start}-{end} runs past the file"
        ));
    }
    if !lines[start - 1..end].join("\n").contains(&entry.quote) {
        return Some(format!(
            "the quote at {path}:{start}-{end} is not copied from those lines"
        ));
    }
    None
}

/// Proves one read-back filing against the skill's five directives.
pub fn verify_filing(
    repo_dir: &Path,
    skill: &SkillDirectives,
    filing: &FilingProvenance,
) -> ProvenanceResult {
    let mut labels: Vec<String> = filing.labels.clone();
    labels.sort();
    labels.dedup();
    if labels.len() != 1 || labels[0] != SINGLE_RESPONSIBILITY_LABEL {
        return ProvenanceResult::Problem(format!(
            "the labels are {}, not exactly [\"{SINGLE_RESPONSIBILITY_LABEL}\"]",
            serde_json::to_string(&filing.labels).unwrap_or_default()
        ));
    }
    let title = filing.title.trim();
    if title.is_empty()
        || filing.title.contains('\r')
        || filing.title.contains('\n')
        || title.chars().count() > TITLE_MAX
    {
        return ProvenanceResult::Problem(format!(
            "the title is not one plain line of at most {TITLE_MAX} characters"
        ));
    }
    let prefixed = title.starts_with('[') && title.contains(']');
    let lower = title.to_lowercase();
    if prefixed || lower.starts_with("single-responsibility") && lower.contains(':') {
        return ProvenanceResult::Problem("the title carries a prefix".to_string());
    }
    let mentioned: Vec<&str> = SINGLE_RESPONSIBILITY_CATEGORIES
        .iter()
        .copied()
        .filter(|category| filing.body.contains(category))
        .collect();
    if mentioned.len() != 1 {
        return ProvenanceResult::Problem(if mentioned.is_empty() {
            "the body names none of the five categories".to_string()
        } else {
            format!(
                "the body names {} categories: {}",
                mentioned.len(),
                mentioned.join(", ")
            )
        });
    }
    let category = mentioned[0];
    if section(&filing.body, "Category").unwrap_or_default().trim() != category {
        return ProvenanceResult::Problem(format!(
            "the Category section is not exactly {category}"
        ));
    }
    if !filing.body.contains(&skill.path) {
        return ProvenanceResult::Problem(format!(
            "the body does not cite the skill path {}",
            skill.path
        ));
    }
    let Some(directive) = skill.directives.get(category) else {
        return ProvenanceResult::Problem(format!(
            "the body does not quote the {category} directive verbatim"
        ));
    };
    if !filing.body.contains(directive) {
        return ProvenanceResult::Problem(format!(
            "the body does not quote the {category} directive verbatim"
        ));
    }
    for heading in [
        "Component",
        "Why the responsibilities are mixed",
        "Refactor",
        "Acceptance criteria",
    ] {
        let content = section(&filing.body, heading).unwrap_or_default();
        if content.trim().is_empty() {
            return ProvenanceResult::Problem(format!("the body has no {heading} section"));
        }
    }
    let criteria = section(&filing.body, "Acceptance criteria").unwrap_or_default();
    let binary = criteria
        .split('\n')
        .any(|line| line.trim_start().starts_with("- ") && line.trim().len() > 2);
    if !binary {
        return ProvenanceResult::Problem(
            "the acceptance criteria carry no binary statement".to_string(),
        );
    }
    let evidence = evidence_entries(&filing.body);
    if evidence.is_empty() {
        return ProvenanceResult::Problem(
            "the body carries no evidence entry with a line span and quote".to_string(),
        );
    }
    for entry in &evidence {
        if let Some(problem) = prove_evidence(repo_dir, entry) {
            return ProvenanceResult::Problem(problem);
        }
    }
    ProvenanceResult::Ok(category.to_string())
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
    pub skill_path: String,
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
            "skillPath": self.skill_path,
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
    Err("could not allocate a unique single-responsibility cycle directory".to_string())
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
    let pick = pick_entry_point_for(&repo_dir, "single-responsibility", None)?;
    let config = single_responsibility_config();
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
        categories: SINGLE_RESPONSIBILITY_CATEGORIES
            .iter()
            .map(|value| value.to_string())
            .collect(),
        skill_path: config.skill_document,
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
    format!("/single-responsibility {}", directory.display())
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
    pub body: String,
    pub labels: Vec<String>,
}

pub type ForgeFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;

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
                .list_labelled(
                    crate::forge::IssueQueryState::All,
                    SINGLE_RESPONSIBILITY_LABEL,
                )
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

pub fn create_forge(repo_dir: &Path) -> Result<Arc<dyn ForgeClient>, String> {
    Ok(Arc::new(RealForge::new(repo_dir)?))
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
    config: Config,
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
            config: Config::default(),
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
                        "Single Responsibility settings must be 1 through 1440 minutes and nullable 1..100 caps.",
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

    /// The labelled issues, read alone.
    ///
    /// The open-issue titles are not part of the periodic read: only a cycle
    /// consumes them, so `begin_cycle` reads them where the duplicate guard
    /// uses them. Walking the whole open history on every sync kept that read
    /// outside its deadline and raised the forge-read error notification.
    async fn read_forge(&self) -> Result<Vec<ForgeIssue>, String> {
        let forge = lock(&self.inner).forge.clone();
        let Some(forge) = forge else {
            return Err("no forge client is configured".to_string());
        };
        forge.list_issues().await
    }

    async fn read_forge_within_deadline(&self) -> Result<Vec<ForgeIssue>, String> {
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

    /// The open-issue titles a cycle needs for its duplicate check.
    ///
    /// Best effort: a failure is logged and the last known titles stay in use,
    /// so a slow forge never blocks a cycle.
    async fn refresh_open_titles(&self) {
        let forge = lock(&self.inner).forge.clone();
        let Some(forge) = forge else {
            return;
        };
        match tokio::time::timeout(
            Duration::from_millis(self.read_timeout_ms),
            forge.list_open_issue_titles(),
        )
        .await
        {
            Ok(Ok(titles)) => lock(&self.inner).open_titles = titles,
            Ok(Err(detail)) => (self.log)(format!("could not read open issue titles: {detail}")),
            Err(_) => (self.log)(format!(
                "could not read open issue titles: the forge read did not finish within {} ms",
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
            Ok(issues) => {
                self.apply_read(issues, None);
                lock(&self.inner).retry.succeed();
                lock(&self.inner).next_sync_at = self.now() + self.sync_ms as i64;
                self.publish();
            }
        }
        lock(&self.inner).syncing = false;
    }

    fn apply_read(&self, issues: Vec<ForgeIssue>, record: Option<&dyn Fn(String)>) {
        let previous: HashMap<i64, IssueRow> = lock(&self.inner)
            .state
            .issues
            .iter()
            .cloned()
            .map(|row| (row.number, row))
            .collect();
        let mut skill: Option<SkillDirectives> = None;
        let mut skill_error: Option<String> = None;
        let mut rows: Vec<IssueRow> = Vec::new();
        for issue in issues {
            let before = previous.get(&issue.number);
            let state = if issue.state == "closed" {
                IssueState::Implemented
            } else {
                IssueState::Pending
            };
            if let Some(before) = before {
                rows.push(IssueRow {
                    number: issue.number,
                    title: issue.title,
                    url: issue.url,
                    created_at: issue.created_at,
                    state,
                    category: before.category.clone(),
                    version: if state == IssueState::Implemented {
                        before.version.clone()
                    } else {
                        None
                    },
                });
                continue;
            }
            if skill.is_none() && skill_error.is_none() {
                match read_skill_directives(&self.repo_dir, &self.config.skill_document) {
                    Ok(found) => skill = Some(found),
                    Err(error) => skill_error = Some(error),
                }
            }
            let Some(skill) = skill.as_ref() else {
                if let Some(record) = record {
                    record(format!(
                        "verification failure: #{} “{}”: {}",
                        issue.number,
                        issue.title,
                        skill_error
                            .clone()
                            .unwrap_or_else(|| "no skill".to_string())
                    ));
                }
                continue;
            };
            let filing = FilingProvenance {
                title: issue.title.clone(),
                body: issue.body.clone(),
                labels: issue.labels.clone(),
            };
            match verify_filing(&self.repo_dir, skill, &filing) {
                ProvenanceResult::Problem(detail) => {
                    if let Some(record) = record {
                        record(format!(
                            "verification failure: #{} “{}”: {detail}",
                            issue.number, issue.title
                        ));
                    }
                }
                ProvenanceResult::Ok(category) => rows.push(IssueRow {
                    number: issue.number,
                    title: issue.title,
                    url: issue.url,
                    created_at: issue.created_at,
                    state,
                    category: Some(category),
                    version: None,
                }),
            }
        }
        rows.sort_by(newest_first);
        {
            let mut inner = lock(&self.inner);
            inner.state.issues = rows;
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

    /// Whether a cycle may claim and start now.
    fn can_begin(&self) -> bool {
        let inner = lock(&self.inner);
        !inner.stopping
            && !inner.draining
            && inner.active.is_none()
            && !inner.cycling
            && inner.state.enabled
    }

    pub async fn begin_cycle(&self) {
        if !self.can_begin() {
            return;
        }
        // The duplicate-title guard consumes the open titles, so they are read
        // here, once per cycle, instead of on every periodic sync.
        self.refresh_open_titles().await;
        if !self.can_begin() {
            return;
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
        activity.push(format!(
            "cycle {cycle_id}: surface {}, skill {}, categories {}, room {requested}, caps {}/{}",
            request.surface,
            request.skill_path,
            request.categories.join(", "),
            limit_label(max_per_hour),
            limit_label(max_pending)
        ));
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
            inner.state.lifecycle = Lifecycle::Auditing;
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
            inner.state.notice = Some(format!("Single Responsibility cycle failed: {detail}"));
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
        match self.read_forge_within_deadline().await {
            Ok(issues) => self.apply_read(issues, Some(&record)),
            Err(failure) => record(format!("could not re-read the forge: {failure}")),
        }
        if let Some(error) = &error {
            record(format!("filing stopped: {error}"));
        }
        self.finish_cycle(cycle_id, error);
    }

    fn fail_cycle(&self, cycle_id: &str, detail: &str) {
        let (first_line, _directory) = {
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
            (first, active.directory.clone())
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
                inner.state.notice = Some(format!("Single Responsibility cycle failed: {error}"));
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

/// Runs one Single Responsibility worker until Stop or drain.
pub async fn run(invocation: &WorkerInvocation) -> anyhow::Result<()> {
    let Some((repo_dir, state_dir, sync_ms)) = parse_arguments(invocation) else {
        eprintln!("usage: devboard worker single-responsibility --repo <checkout> --state-dir <dir> [--sync <ms>]");
        std::process::exit(2);
    };
    let environment = crate::forge::process_environment();
    let repository =
        crate::forge::origin_repository_with(&repo_dir, &environment).unwrap_or_default();
    if repository.is_empty() {
        eprintln!("single-responsibility worker: the checkout's origin does not name a repository");
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
            "single-responsibility worker: this checkout already has a live single-responsibility agent for this version"
        );
        std::process::exit(0);
    }
    let sync_ms = sync_ms.or_else(|| environment_millis("SINGLE_RESPONSIBILITY_SYNC_MS", 1000));
    let cadence_ms = environment_millis("SINGLE_RESPONSIBILITY_CADENCE_MS", 100);
    let mut options = WorkerOptions::new(&repo_dir, &state_dir);
    options.harness_version = harness_version;
    options.sync_ms = sync_ms;
    options.cadence_ms = cadence_ms;
    options.log = Some(Arc::new(|line: String| {
        eprintln!("single-responsibility: {line}")
    }));
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
                eprintln!("single-responsibility: received a shutdown signal");
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
    pub config: Config,
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
    path_inside(root, path) && {
        let local = absolute(path);
        let root = absolute(root);
        local != root
    }
}

fn home_directory(environment: &HashMap<String, String>) -> PathBuf {
    environment
        .get("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_default()
}

/// The installed `/single-responsibility` command: checkout first, then home.
pub fn single_responsibility_command_paths(
    repo_dir: &Path,
    environment: &HashMap<String, String>,
) -> Vec<PathBuf> {
    let home = home_directory(environment);
    vec![
        absolute(repo_dir)
            .join(".omp")
            .join("commands")
            .join("single-responsibility.md"),
        home.join(".omp")
            .join("commands")
            .join("single-responsibility.md"),
        home.join(".omp")
            .join("agent")
            .join("commands")
            .join("single-responsibility.md"),
    ]
}

/// Everything Start proves before it spawns the worker.
pub async fn preflight_single_responsibility(options: &PreflightOptions) -> Result<String, String> {
    let environment = &options.environment;
    let root = absolute(&options.repo_dir);
    if let Some(problem) = crate::forge::root_problem(&root) {
        return Err(problem);
    }
    let repo_real = std::fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
    let skill_path = root.join(&options.config.skill_document);
    let skill_metadata = match std::fs::symlink_metadata(&skill_path) {
        Ok(metadata) => metadata,
        Err(_) => {
            return Err(format!(
                "missing prerequisite: the skill {} is not readable",
                options.config.skill_document
            ))
        }
    };
    let skill_real = match std::fs::canonicalize(&skill_path) {
        Ok(path) => path,
        Err(_) => {
            return Err(format!(
                "missing prerequisite: the skill {} is not readable",
                options.config.skill_document
            ))
        }
    };
    if !path_inside(&repo_real, &skill_real) {
        return Err(format!(
            "missing prerequisite: the skill {} resolves outside the repository",
            options.config.skill_document
        ));
    }
    if !skill_metadata.is_file() || skill_metadata.file_type().is_symlink() {
        return Err(format!(
            "missing prerequisite: the skill {} is not a regular file",
            options.config.skill_document
        ));
    }
    if let Err(detail) = read_skill_directives(&root, &options.config.skill_document) {
        return Err(format!(
            "missing prerequisite: the skill is unusable: {detail}"
        ));
    }
    if !inside(&options.repo_dir, &options.state_dir) {
        return Err(format!(
            "STATE_DIR {} is not inside REPO_DIR {}; the single-responsibility worker keeps its state beside the checkout",
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
            "the Single Responsibility agent supports a GitHub or Gitea origin, not a GitLab one: {}",
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
    let command_paths = single_responsibility_command_paths(&root, environment);
    if !command_paths.iter().any(|path| path.exists()) {
        let looked = command_paths
            .iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "missing prerequisite: the /single-responsibility command is not installed for omp \
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
        format!("repos/{repository}/labels/{SINGLE_RESPONSIBILITY_LABEL}"),
        "--jq".to_string(),
        ".name".to_string(),
    ])
    .await;
    if label.code != 0 || label.stdout.trim() != SINGLE_RESPONSIBILITY_LABEL {
        let created = run(vec![
            "label".to_string(),
            "create".to_string(),
            SINGLE_RESPONSIBILITY_LABEL.to_string(),
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
                "missing prerequisite: the \"{SINGLE_RESPONSIBILITY_LABEL}\" label could not be created in {repository}: {}",
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
    if !labels
        .iter()
        .any(|label| label.name == SINGLE_RESPONSIBILITY_LABEL)
    {
        match crate::forge::gitea_create_label(
            &target,
            SINGLE_RESPONSIBILITY_LABEL,
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
                    .map(|labels| {
                        labels
                            .iter()
                            .any(|label| label.name == SINGLE_RESPONSIBILITY_LABEL)
                    })
                    .unwrap_or(false);
                if !present {
                    return Err(format!(
                        "missing prerequisite: the \"{SINGLE_RESPONSIBILITY_LABEL}\" label could not be created in {repository}: {}",
                        error.message
                    ));
                }
            }
        }
    }
    Ok(repository.to_string())
}
