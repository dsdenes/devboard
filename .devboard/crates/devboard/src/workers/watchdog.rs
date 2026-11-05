//! The watchdog worker family: one machine-level engine per host root.
//!
//! A worker discovers every dashboard on the machine, prunes the journals it
//! reads, sweeps age-based retention over every covered state directory,
//! collects machine-checkable evidence, and files or comments one issue per
//! distinct signal. It never fixes, merges, pushes, or publishes.
//!
//! The port keeps the TypeScript durable surface byte-compatible: the
//! versioned worker lock and published state, the cross-version cycle lease,
//! the command channel, settings, projection, ledger, runs, and exit codes.

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::journal::{journal_file, journal_key};
use crate::supervision::{
    ancestry, process_snapshot, process_table, start_orphan_supervisor, ProcessSnapshot,
};
use crate::version::read_harness_version;

use super::WorkerInvocation;

// ---------------------------------------------------------------------------
// Constants and paths
// ---------------------------------------------------------------------------

/// The machine-level watchdog directory under a host's `.devboard/.tmp`.
pub const WATCHDOG_DIRECTORY: &str = "watchdog";
/// The published worker state's schema version.
pub const WORKER_STATE_VERSION: i64 = 1;
/// The forge projection's schema version.
pub const PROJECTION_VERSION: i64 = 1;
/// The ledger's schema version; version 1 belonged to the retired fix pipeline.
pub const LEDGER_VERSION: i64 = 2;
/// The evidence window the detached worker uses when no cadence is configured.
pub const WINDOW_MS: u64 = 10 * 60 * 1000;
/// A start this long before window end with no matching stop is a stall.
pub const STALL_MS: i64 = 5 * 60 * 1000;
/// This many questions for one instance in one window is a loop.
pub const QUESTION_LOOP_COUNT: usize = 3;
/// How long an existing issue waits before a recurrence comments on it.
pub const COMMENT_INTERVAL_MS: i64 = 24 * 60 * 60 * 1000;
/// Rotated journals older than this leave at cycle start.
pub const JOURNAL_RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// Total journal bytes the watchdog keeps, unless the live window is larger.
pub const JOURNAL_MAX_BYTES: u64 = 1024 * 1024 * 1024;
/// Age-based retention for everything else a state directory accumulates.
pub const CLEANUP_RETENTION_MS: i64 = JOURNAL_RETENTION_MS;
/// The detached worker's control poll.
pub const CONTROL_POLL_MS: u64 = 250;
/// The verification stub that answers every deduplication call.
pub const DEDUP_STUB_ENV: &str = "DEVBOARD_WATCHDOG_DEDUP_STUB";
/// A repository's repo-scoped state directory is named by its journal key.
const REPO_STATE_DIRECTORY_LEN: usize = 24;

/// `<root>/.devboard/.tmp/watchdog`.
pub fn watchdog_directory(root: &Path) -> PathBuf {
    absolute(root)
        .join(".devboard")
        .join(".tmp")
        .join(WATCHDOG_DIRECTORY)
}

/// The legacy published worker state beside every version directory.
pub fn worker_state_path(directory: &Path) -> PathBuf {
    directory.join("worker.json")
}

/// The directory holding one worker directory per harness version.
pub fn workers_directory(directory: &Path) -> PathBuf {
    directory.join("workers")
}

/// One worker version's state directory, beside the legacy state older
/// harnesses write.
pub fn versioned_worker_directory(directory: &Path, version: Option<&str>) -> PathBuf {
    workers_directory(directory).join(worker_version_key(version))
}

pub fn versioned_worker_state_path(directory: &Path, version: Option<&str>) -> PathBuf {
    versioned_worker_directory(directory, version).join("worker.json")
}

pub fn versioned_control_directory(directory: &Path, version: Option<&str>) -> PathBuf {
    versioned_worker_directory(directory, version).join("control")
}

/// Every versioned worker directory under one watchdog directory, sorted.
pub fn worker_state_directories(directory: &Path) -> Vec<PathBuf> {
    let root = workers_directory(directory);
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

/// A version's own lock beside the legacy lock a pre-mechanism worker holds.
pub fn versioned_lock_path(base: &Path, version: Option<&str>) -> PathBuf {
    PathBuf::from(format!(
        "{}.{}",
        base.display(),
        worker_version_key(version)
    ))
}

/// The one-family lease that serialises watchdog cycles across versions.
pub fn cycle_claim_path(directory: &Path) -> PathBuf {
    directory.join("cycle-claim.json")
}

pub fn settings_path(directory: &Path) -> PathBuf {
    directory.join("settings.json")
}

pub fn control_directory(directory: &Path) -> PathBuf {
    directory.join("control")
}

pub fn ledger_path(directory: &Path) -> PathBuf {
    directory.join("state.json")
}

pub fn lock_path(directory: &Path) -> PathBuf {
    directory.join("lock")
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

/// The absolute form of one path, without resolving symlinks.
fn absolute(path: &Path) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
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

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/// The current instant in epoch milliseconds.
pub fn epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

static ISO_FORMAT: LazyLock<Vec<time::format_description::FormatItem<'static>>> =
    LazyLock::new(|| {
        time::format_description::parse_borrowed::<2>(
            "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z",
        )
        .expect("the ISO format description")
    });

/// `new Date(ms).toISOString()`.
pub fn iso_from_ms(ms: i64) -> String {
    let nanos = (ms as i128) * 1_000_000;
    let instant = time::OffsetDateTime::from_unix_timestamp_nanos(nanos)
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    instant
        .format(&ISO_FORMAT)
        .unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".to_string())
}

/// The current instant as an ISO 8601 UTC timestamp with milliseconds.
pub fn now_iso() -> String {
    iso_from_ms(epoch_ms())
}

/// The instant one ISO timestamp names, or `None` when it is unusable.
///
/// The dashboard writes RFC 3339 UTC timestamps; this parses the calendar
/// form directly because the crate's `time` dependency carries formatting but
/// not parsing.
pub fn parse_iso_ms(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let digits = |from: usize, to: usize| -> Option<i64> {
        let slice = bytes.get(from..to)?;
        if !slice.iter().all(u8::is_ascii_digit) {
            return None;
        }
        std::str::from_utf8(slice).ok()?.parse::<i64>().ok()
    };
    let year = digits(0, 4)?;
    if bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let month = digits(5, 7)?;
    let day = digits(8, 10)?;
    if !matches!(bytes[10], b'T' | b't' | b' ') || bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }
    let hour = digits(11, 13)?;
    let minute = digits(14, 16)?;
    let second = digits(17, 19)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let mut index = 19;
    let mut millis = 0_i64;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == start {
            return None;
        }
        let fraction = std::str::from_utf8(&bytes[start..index]).ok()?;
        let mut padded = fraction.to_string();
        while padded.len() < 3 {
            padded.push('0');
        }
        millis = padded.get(0..3)?.parse::<i64>().ok()?;
    }
    let offset_minutes = match bytes.get(index) {
        None => 0,
        Some(b'Z') | Some(b'z') if index + 1 == bytes.len() => 0,
        Some(sign @ (b'+' | b'-')) => {
            let sign = if *sign == b'-' { -1 } else { 1 };
            let hours = digits(index + 1, index + 3)?;
            let minutes = digits(index + 4, index + 6)?;
            if bytes.get(index + 3) != Some(&b':') {
                return None;
            }
            sign * (hours * 60 + minutes)
        }
        Some(_) => return None,
    };
    let seconds = days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second
        - offset_minutes * 60;
    Some(seconds * 1000 + millis)
}

/// Days since 1970-01-01 for one proleptic Gregorian date.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let shifted_month = (month + 9) % 12;
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// One file's modification instant in epoch milliseconds.
fn modified_ms(path: &Path) -> Option<i64> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    let modified = metadata.modified().ok()?;
    Some(
        modified
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or(0),
    )
}

// ---------------------------------------------------------------------------
// Atomic JSON writes
// ---------------------------------------------------------------------------

/// Writes one JSON document atomically with a two-space indent and a trailing
/// newline, exactly as `JSON.stringify(value, null, 2) + "\n"` would.
pub fn write_json_atomic(path: &Path, value: &Value) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    let mut text = serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".to_string());
    text.push('\n');
    std::fs::write(&temporary, text)?;
    std::fs::rename(&temporary, path)
}

/// Reads one JSON document, or `None` when it is missing or unparseable.
pub fn read_json(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn json_integer(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::Number(number)) => number.as_i64(),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Process identity
// ---------------------------------------------------------------------------

/// True when a signal of zero would be delivered, `EPERM` included.
pub fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(unix)]
    {
        if unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 {
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
    if !cfg!(target_os = "linux") || pid == 0 {
        return None;
    }
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let close = stat.rfind(')')?;
    let suffix = stat.get(close + 2..)?;
    let start_ticks = suffix.split(' ').nth(19)?.parse::<f64>().ok()?;
    let uptime = std::fs::read_to_string("/proc/uptime").ok()?;
    let uptime_seconds = uptime.split(' ').next()?.parse::<f64>().ok()?;
    if !uptime_seconds.is_finite() || !start_ticks.is_finite() {
        return None;
    }
    let now = epoch_ms() as f64;
    Some((now - uptime_seconds * 1000.0 + start_ticks * 10.0) as i64)
}

/// Slack between a recorded start and the same process's start read back from
/// `/proc`.
const START_TIME_TOLERANCE_MS: i64 = 2_000;

/// The instant this process started, for the lock it writes.
fn own_started_at() -> String {
    let started = process_started_at(std::process::id()).unwrap_or_else(|| {
        let uptime = std::fs::read_to_string("/proc/uptime")
            .ok()
            .and_then(|text| text.split(' ').next().map(str::to_string))
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(0.0);
        epoch_ms() - (uptime * 1000.0) as i64
    });
    iso_from_ms(started)
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/// What the dashboard persists and the worker applies without a restart.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WatchdogSettings {
    pub interval_minutes: i64,
    /// `None` means unlimited.
    pub max_per_hour: Option<i64>,
    /// `None` means unlimited.
    pub max_pending: Option<i64>,
}

impl Default for WatchdogSettings {
    fn default() -> Self {
        Self {
            interval_minutes: 10,
            max_per_hour: None,
            max_pending: None,
        }
    }
}

impl WatchdogSettings {
    pub fn to_json(&self) -> Value {
        json!({
            "intervalMinutes": self.interval_minutes,
            "maxPerHour": self.max_per_hour,
            "maxPending": self.max_pending,
        })
    }
}

pub fn is_valid_cadence(value: i64) -> bool {
    (1..=1440).contains(&value)
}

pub fn is_valid_limit(value: Option<i64>) -> bool {
    match value {
        None => true,
        Some(number) => (1..=100).contains(&number),
    }
}

fn parse_limit(value: Option<&Value>) -> Option<Option<i64>> {
    match value {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::Number(number)) => {
            let number = number.as_i64()?;
            if is_valid_limit(Some(number)) {
                Some(Some(number))
            } else {
                None
            }
        }
        Some(_) => None,
    }
}

pub fn parse_watchdog_settings(text: &str) -> Option<WatchdogSettings> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    let record = parsed.as_object()?;
    let interval = json_integer(record.get("intervalMinutes"))?;
    if !is_valid_cadence(interval) {
        return None;
    }
    let max_per_hour = parse_limit(record.get("maxPerHour"))?;
    let max_pending = parse_limit(record.get("maxPending"))?;
    Some(WatchdogSettings {
        interval_minutes: interval,
        max_per_hour,
        max_pending,
    })
}

/// The persisted settings, or the defaults when the file is missing or
/// unusable.
pub fn read_watchdog_settings(directory: &Path) -> WatchdogSettings {
    std::fs::read_to_string(settings_path(directory))
        .ok()
        .and_then(|text| parse_watchdog_settings(&text))
        .unwrap_or_default()
}

pub fn write_watchdog_settings(directory: &Path, settings: &WatchdogSettings) -> io::Result<()> {
    write_json_atomic(&settings_path(directory), &settings.to_json())
}

// ---------------------------------------------------------------------------
// Published worker state
// ---------------------------------------------------------------------------

/// The detached worker's published lifecycle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentLifecycle {
    Stopped,
    Starting,
    Running,
    Stopping,
    Failed,
}

impl AgentLifecycle {
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

/// The only thing the dashboard needs to read to know whether the worker is
/// starting, running, stopping, stopped, or failed.
#[derive(Clone, Debug, PartialEq)]
pub struct WatchdogWorkerState {
    pub version: i64,
    pub pid: u32,
    pub started_at: String,
    pub root: String,
    pub state_dir: String,
    pub lifecycle: AgentLifecycle,
    pub enabled: bool,
    pub harness_version: Option<String>,
    pub argv: Vec<String>,
    pub last_run_at: Option<String>,
    pub next_run_at: Option<String>,
    pub last_error: Option<String>,
    pub notice: Option<String>,
    /// True once a newer version asked this worker to finish and exit.
    pub draining: bool,
    pub updated_at: String,
}

impl WatchdogWorkerState {
    pub fn to_json(&self) -> Value {
        let mut value = json!({
            "version": self.version,
            "pid": self.pid,
            "startedAt": self.started_at,
            "root": self.root,
            "stateDir": self.state_dir,
            "lifecycle": self.lifecycle.as_str(),
            "enabled": self.enabled,
            "harnessVersion": self.harness_version,
            "argv": self.argv,
            "lastRunAt": self.last_run_at,
            "nextRunAt": self.next_run_at,
            "lastError": self.last_error,
            "notice": self.notice,
        });
        if self.draining {
            value["draining"] = json!(true);
        }
        value["updatedAt"] = json!(self.updated_at);
        value
    }
}

pub fn parse_worker_state(text: &str) -> Option<WatchdogWorkerState> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    let record = parsed.as_object()?;
    if json_integer(record.get("version")) != Some(WORKER_STATE_VERSION) {
        return None;
    }
    let pid = json_integer(record.get("pid"))?;
    if pid <= 0 {
        return None;
    }
    let started_at = record.get("startedAt")?.as_str()?;
    let root = record.get("root")?.as_str()?;
    let state_dir = record.get("stateDir")?.as_str()?;
    let lifecycle = AgentLifecycle::parse(record.get("lifecycle")?.as_str()?)?;
    let enabled = record.get("enabled")?.as_bool()?;
    let harness_version = nullable_string(record.get("harnessVersion"))?;
    let argv_value = record.get("argv")?.as_array()?;
    let mut argv = Vec::with_capacity(argv_value.len());
    for entry in argv_value {
        argv.push(entry.as_str()?.to_string());
    }
    let last_run_at = nullable_string(record.get("lastRunAt"))?;
    let next_run_at = nullable_string(record.get("nextRunAt"))?;
    let last_error = nullable_string(record.get("lastError"))?;
    let notice = nullable_string(record.get("notice"))?;
    let updated_at = record.get("updatedAt")?.as_str()?;
    Some(WatchdogWorkerState {
        version: WORKER_STATE_VERSION,
        pid: pid as u32,
        started_at: started_at.to_string(),
        root: root.to_string(),
        state_dir: state_dir.to_string(),
        lifecycle,
        enabled,
        harness_version,
        argv,
        last_run_at,
        next_run_at,
        last_error,
        notice,
        draining: record.get("draining") == Some(&Value::Bool(true)),
        updated_at: updated_at.to_string(),
    })
}

fn nullable_string(value: Option<&Value>) -> Option<Option<String>> {
    match value {
        Some(Value::Null) => Some(None),
        Some(Value::String(text)) => Some(Some(text.clone())),
        _ => None,
    }
}

pub fn read_worker_state(directory: &Path) -> Option<WatchdogWorkerState> {
    std::fs::read_to_string(worker_state_path(directory))
        .ok()
        .and_then(|text| parse_worker_state(&text))
}

pub fn write_worker_state(directory: &Path, state: &WatchdogWorkerState) -> io::Result<()> {
    write_json_atomic(&worker_state_path(directory), &state.to_json())
}

/// Every readable worker state: the legacy file and each version's file.
pub fn read_worker_states(directory: &Path) -> Vec<WatchdogWorkerState> {
    let mut states = Vec::new();
    if let Some(legacy) = read_worker_state(directory) {
        states.push(legacy);
    }
    for version_directory in worker_state_directories(directory) {
        if let Some(state) = read_worker_state(&version_directory) {
            states.push(state);
        }
    }
    states
}

/// The newest published state, whichever version wrote it last.
pub fn read_newest_worker_state(directory: &Path) -> Option<WatchdogWorkerState> {
    let mut states = read_worker_states(directory);
    states.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    states.into_iter().next()
}

// ---------------------------------------------------------------------------
// Worker lock
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LockOwner {
    pub pid: u32,
    pub started_at: String,
    pub repo: String,
    pub state_dir: String,
    pub harness_version: Option<String>,
    pub argv: Vec<String>,
}

/// The fields a caller supplies; pid and start come from the process itself.
#[derive(Clone, Debug, Default)]
pub struct LockDetails {
    pub repo: String,
    pub state_dir: String,
    pub harness_version: Option<String>,
    pub argv: Vec<String>,
}

/// A held lock; `release` removes only this acquisition's file.
#[derive(Debug)]
pub struct LockHandle {
    path: PathBuf,
    token: String,
    pub owner: LockOwner,
}

/// The result of taking a lock.
#[derive(Debug)]
pub enum LockResult {
    Acquired(LockHandle),
    Busy(Option<LockOwner>),
}

impl LockHandle {
    pub fn release(&self) {
        let Some(current) = read_snapshot(&self.path) else {
            let _ = std::fs::remove_file(&self.path);
            return;
        };
        if current.token.as_deref() != Some(self.token.as_str()) {
            return;
        }
        let _ = std::fs::remove_file(&self.path);
    }
}

#[derive(Clone, Debug)]
struct LockSnapshot {
    owner: Option<LockOwner>,
    token: Option<String>,
    device: u64,
    inode: u64,
}

fn parse_lock(content: &str) -> (Option<LockOwner>, Option<String>) {
    let Ok(parsed) = serde_json::from_str::<Value>(content) else {
        return (None, None);
    };
    let Some(record) = parsed.as_object() else {
        return (None, None);
    };
    let Some(pid) = json_integer(record.get("pid")) else {
        return (None, None);
    };
    let Some(started_at) = record.get("startedAt").and_then(Value::as_str) else {
        return (None, None);
    };
    if pid <= 0 {
        return (None, None);
    }
    let owner = LockOwner {
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
        argv: record
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
    };
    let token = record
        .get("token")
        .and_then(Value::as_str)
        .map(str::to_string);
    (Some(owner), token)
}

fn read_snapshot(path: &Path) -> Option<LockSnapshot> {
    #[cfg(unix)]
    let (device, inode) = {
        use std::os::unix::fs::MetadataExt;
        let metadata = std::fs::metadata(path).ok()?;
        (metadata.dev(), metadata.ino())
    };
    #[cfg(not(unix))]
    let (device, inode) = (0, 0);
    let content = std::fs::read_to_string(path).ok()?;
    let (owner, token) = parse_lock(&content);
    Some(LockSnapshot {
        owner,
        token,
        device,
        inode,
    })
}

/// The lock's owner, if the file is present and readable.
pub fn read_lock(path: &Path) -> Option<LockOwner> {
    read_snapshot(path).and_then(|snapshot| snapshot.owner)
}

fn owner_alive(owner: &LockOwner) -> bool {
    if !pid_alive(owner.pid) {
        return false;
    }
    let Some(recorded) = parse_iso_ms(&owner.started_at) else {
        return false;
    };
    match process_started_at(owner.pid) {
        None => !cfg!(target_os = "linux"),
        Some(actual) => (actual - recorded).abs() <= START_TIME_TOLERANCE_MS,
    }
}

/// The live owner of a lock, or `None` when it is missing or stale.
pub fn live_lock_owner(path: &Path) -> Option<LockOwner> {
    let owner = read_lock(path)?;
    owner_alive(&owner).then_some(owner)
}

/// Every live owner beside one lock path: the legacy lock and each version.
pub fn live_lock_owners(path: &Path) -> Vec<LockOwner> {
    let mut owners = Vec::new();
    if let Some(legacy) = live_lock_owner(path) {
        owners.push(legacy);
    }
    let (Some(directory), Some(base)) = (path.parent(), path.file_name()) else {
        return owners;
    };
    let Ok(entries) = std::fs::read_dir(directory) else {
        return owners;
    };
    let prefix = format!("{}.", base.to_string_lossy());
    let mut names: Vec<String> = entries
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| {
            name.starts_with(&prefix) && !name.contains(".reclaim-") && !name.contains(".new-")
        })
        .collect();
    names.sort();
    for name in names {
        if let Some(owner) = live_lock_owner(&directory.join(name)) {
            owners.push(owner);
        }
    }
    owners
}

fn same_lock_file(left: &LockSnapshot, right: &LockSnapshot) -> bool {
    match (left.token.as_deref(), right.token.as_deref()) {
        (None, None) => left.device == right.device && left.inode == right.inode,
        (left_token, right_token) => left_token.is_some() && left_token == right_token,
    }
}

/// Reclaims `inspected` without guessing what currently sits at `path`.
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
    let Some(moved) = moved else {
        let _ = std::fs::hard_link(&aside, path);
        let _ = std::fs::remove_file(&aside);
        return;
    };
    if !same_lock_file(inspected, &moved) {
        if std::fs::hard_link(&aside, path).is_err() {
            return;
        }
        let _ = std::fs::remove_file(&aside);
        return;
    }
    let _ = std::fs::remove_file(&aside);
}

/// Takes the lock, or reports the live owner. A lock whose owner is gone or
/// whose pid was recycled is reclaimed once.
pub fn acquire_lock(path: &Path, details: &LockDetails) -> LockResult {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let owner = LockOwner {
        pid: std::process::id(),
        started_at: own_started_at(),
        repo: details.repo.clone(),
        state_dir: details.state_dir.clone(),
        harness_version: details.harness_version.clone(),
        argv: details.argv.clone(),
    };
    let token = uuid::Uuid::new_v4().to_string();
    for _attempt in 0..2 {
        let staged = PathBuf::from(format!(
            "{}.new-{}-{}",
            path.display(),
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let published = (|| -> io::Result<()> {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staged)?;
            let mut record = owner_json(&owner);
            record["token"] = json!(token);
            let mut text = crate::jsjson::stringify(&record);
            text.push('\n');
            file.write_all(text.as_bytes())?;
            drop(file);
            std::fs::hard_link(&staged, path)
        })();
        let _ = std::fs::remove_file(&staged);
        match published {
            Ok(()) => {
                return LockResult::Acquired(LockHandle {
                    path: path.to_path_buf(),
                    token,
                    owner,
                })
            }
            Err(error) => {
                if error.kind() != io::ErrorKind::AlreadyExists {
                    return LockResult::Busy(None);
                }
                let Some(snapshot) = read_snapshot(path) else {
                    continue;
                };
                if let Some(holder) = &snapshot.owner {
                    if owner_alive(holder) {
                        return LockResult::Busy(Some(holder.clone()));
                    }
                }
                reclaim_stale_lock(path, &snapshot);
            }
        }
    }
    LockResult::Busy(None)
}

fn owner_json(owner: &LockOwner) -> Value {
    json!({
        "pid": owner.pid,
        "startedAt": owner.started_at,
        "repo": owner.repo,
        "stateDir": owner.state_dir,
        "harnessVersion": owner.harness_version,
        "argv": owner.argv,
    })
}

/// Takes a version's lock, treating a live legacy lock from the same version
/// (or from a worker that recorded no version) as the same worker.
pub fn acquire_worker_lock(
    base: &Path,
    version: Option<&str>,
    details: &LockDetails,
) -> LockResult {
    if let Some(legacy) = live_lock_owner(base) {
        let same = match legacy.harness_version.as_deref() {
            None => true,
            Some(held) => Some(held) == version,
        };
        if same {
            return LockResult::Busy(Some(legacy));
        }
    }
    acquire_lock(&versioned_lock_path(base, version), details)
}

// ---------------------------------------------------------------------------
// Cycle lease
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CycleClaim {
    pub pid: u32,
    pub started_at: String,
    pub harness_version: Option<String>,
    /// Per-acquisition identity, so a release never removes a newer claim.
    pub token: String,
}

fn parse_claim(text: &str) -> Option<CycleClaim> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    let record = parsed.as_object()?;
    let pid = json_integer(record.get("pid"))?;
    if pid <= 0 {
        return None;
    }
    let started_at = record.get("startedAt")?.as_str()?;
    let token = record.get("token")?.as_str()?;
    Some(CycleClaim {
        pid: pid as u32,
        started_at: started_at.to_string(),
        harness_version: record
            .get("harnessVersion")
            .and_then(Value::as_str)
            .map(str::to_string),
        token: token.to_string(),
    })
}

/// The claim at `path`, live or stale, when it is readable.
pub fn read_cycle_claim(path: &Path) -> Option<CycleClaim> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| parse_claim(&text))
}

/// The claim at `path` while its owner is still alive.
pub fn live_cycle_claim(path: &Path) -> Option<CycleClaim> {
    let claim = read_cycle_claim(path)?;
    pid_alive(claim.pid).then_some(claim)
}

fn same_claim(path: &Path, token: &str) -> bool {
    read_cycle_claim(path).is_some_and(|claim| claim.token == token)
}

/// A held cycle lease.
#[derive(Debug)]
pub struct ClaimHandle {
    path: PathBuf,
    token: String,
    pub claim: CycleClaim,
}

impl ClaimHandle {
    pub fn release(&self) {
        if !same_claim(&self.path, &self.token) {
            return;
        }
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Claims the family's next cycle, or reports `None` when another live worker
/// holds it. A claim whose owner exited is reclaimed once.
pub fn claim_cycle(path: &Path, harness_version: Option<&str>) -> Option<ClaimHandle> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let token = uuid::Uuid::new_v4().to_string();
    let claim = CycleClaim {
        pid: std::process::id(),
        started_at: now_iso(),
        harness_version: harness_version.map(str::to_string),
        token: token.clone(),
    };
    for _attempt in 0..2 {
        let staged = PathBuf::from(format!(
            "{}.new-{}-{}",
            path.display(),
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let published = (|| -> io::Result<()> {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staged)?;
            let mut text = crate::jsjson::stringify(&claim_json(&claim));
            text.push('\n');
            file.write_all(text.as_bytes())?;
            drop(file);
            std::fs::hard_link(&staged, path)
        })();
        let _ = std::fs::remove_file(&staged);
        match published {
            Ok(()) => {
                return Some(ClaimHandle {
                    path: path.to_path_buf(),
                    token,
                    claim,
                })
            }
            Err(error) => {
                if error.kind() != io::ErrorKind::AlreadyExists {
                    return None;
                }
                let current = read_cycle_claim(path);
                if let Some(current) = &current {
                    if pid_alive(current.pid) {
                        return None;
                    }
                }
                let _ = std::fs::remove_file(path);
            }
        }
    }
    None
}

fn claim_json(claim: &CycleClaim) -> Value {
    json!({
        "pid": claim.pid,
        "startedAt": claim.started_at,
        "harnessVersion": claim.harness_version,
        "token": claim.token,
    })
}

// ---------------------------------------------------------------------------
// Control channel
// ---------------------------------------------------------------------------

/// The dashboard-to-worker channel.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WatchdogCommand {
    Stop,
    Drain,
    Settings {
        interval_minutes: i64,
        max_per_hour: Option<i64>,
        max_pending: Option<i64>,
    },
}

impl WatchdogCommand {
    pub fn to_json(&self) -> Value {
        match self {
            Self::Stop => json!({"type": "stop"}),
            Self::Drain => json!({"type": "drain"}),
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

/// Writes one instruction atomically; names sort in submission order.
pub fn write_watchdog_command(directory: &Path, command: &WatchdogCommand) -> io::Result<PathBuf> {
    std::fs::create_dir_all(directory)?;
    let sequence = COMMAND_SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1;
    let name = format!("{:014}-{:06}.json", epoch_ms(), sequence);
    let path = directory.join(name);
    let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    let mut text = crate::jsjson::stringify(&command.to_json());
    text.push('\n');
    std::fs::write(&temporary, text)?;
    std::fs::rename(&temporary, &path)?;
    Ok(path)
}

pub fn parse_watchdog_command(text: &str) -> Option<WatchdogCommand> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    let record = parsed.as_object()?;
    match record.get("type").and_then(Value::as_str)? {
        "stop" => Some(WatchdogCommand::Stop),
        "drain" => Some(WatchdogCommand::Drain),
        "settings" => {
            let interval_minutes = json_integer(record.get("intervalMinutes"))?;
            if !is_valid_cadence(interval_minutes) {
                return None;
            }
            let max_per_hour = parse_limit(record.get("maxPerHour"))?;
            let max_pending = parse_limit(record.get("maxPending"))?;
            Some(WatchdogCommand::Settings {
                interval_minutes,
                max_per_hour,
                max_pending,
            })
        }
        _ => None,
    }
}

/// Consumes every command in the directory, oldest name first.
pub fn take_watchdog_commands(directory: &Path) -> Vec<WatchdogCommand> {
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
        if let Some(command) = parse_watchdog_command(&text) {
            commands.push(command);
        }
    }
    commands
}

// ---------------------------------------------------------------------------
// Forge projection
// ---------------------------------------------------------------------------

/// The last forge projection the dashboard computed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WatchdogProjection {
    pub state: ProjectionState,
    pub at: Option<String>,
    pub error: Option<String>,
    pub issues: Vec<ProjectionIssue>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProjectionState {
    Ok,
    Error,
    Stale,
}

impl ProjectionState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Error => "error",
            Self::Stale => "stale",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProjectionIssueState {
    Pending,
    Implemented,
    /// Another forge serves the row: it stays listed and counts as open.
    Unreadable,
}

impl ProjectionIssueState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Implemented => "implemented",
            Self::Unreadable => "unreadable",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectionIssue {
    pub url: String,
    pub state: ProjectionIssueState,
    pub version: Option<String>,
}

impl WatchdogProjection {
    pub fn to_json(&self) -> Value {
        let issues: Vec<Value> = self
            .issues
            .iter()
            .map(|issue| {
                json!({
                    "url": issue.url,
                    "state": issue.state.as_str(),
                    "version": issue.version,
                })
            })
            .collect();
        json!({
            "version": PROJECTION_VERSION,
            "state": self.state.as_str(),
            "at": self.at,
            "error": self.error,
            "issues": issues,
        })
    }
}

pub fn read_projection(directory: &Path) -> Option<WatchdogProjection> {
    let parsed = read_json(&projection_path(directory))?;
    let record = parsed.as_object()?;
    if json_integer(record.get("version")) != Some(PROJECTION_VERSION) {
        return None;
    }
    let state = match record.get("state").and_then(Value::as_str)? {
        "ok" => ProjectionState::Ok,
        "error" => ProjectionState::Error,
        "stale" => ProjectionState::Stale,
        _ => return None,
    };
    let at = nullable_string(record.get("at"))?;
    let error = nullable_string(record.get("error"))?;
    let rows = record.get("issues")?.as_array()?;
    let mut issues = Vec::new();
    for entry in rows {
        let Some(row) = entry.as_object() else {
            continue;
        };
        let Some(url) = row.get("url").and_then(Value::as_str) else {
            continue;
        };
        let state = match row.get("state").and_then(Value::as_str) {
            Some("pending") => ProjectionIssueState::Pending,
            Some("implemented") => ProjectionIssueState::Implemented,
            Some("unreadable") => ProjectionIssueState::Unreadable,
            _ => continue,
        };
        let Some(version) = nullable_string(row.get("version")) else {
            continue;
        };
        issues.push(ProjectionIssue {
            url: url.to_string(),
            state,
            version,
        });
    }
    Some(WatchdogProjection {
        state,
        at,
        error,
        issues,
    })
}

pub fn write_projection(directory: &Path, projection: &WatchdogProjection) -> io::Result<()> {
    write_json_atomic(&projection_path(directory), &projection.to_json())
}

// ---------------------------------------------------------------------------
// Instance discovery
// ---------------------------------------------------------------------------

/// One live dashboard on the machine.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Instance {
    pub pid: u32,
    pub port: u32,
    pub repo_dir: String,
    pub host: String,
    /// Harness directory that serves this dashboard.
    pub harness: String,
    /// The dashboard's own state directory, from `STATE_DIR`.
    pub state_dir: String,
    /// The dashboard's socket credential, from its own environment.
    pub token: String,
    pub journal: String,
    /// False when the serving harness never wrote a journal for this project.
    pub instrumented: bool,
    /// Legacy `.tmp/devboard-<cksum>.log` the starter script wrote.
    pub legacy_log: Option<String>,
}

/// POSIX `cksum` (CRC-32 with the length trailer).
pub fn posix_cksum(data: &[u8]) -> u32 {
    fn advance(mut crc: u32, byte: u8) -> u32 {
        crc ^= (byte as u32) << 24;
        for _ in 0..8 {
            crc = if crc & 0x8000_0000 != 0 {
                (crc << 1) ^ 0x04c1_1db7
            } else {
                crc << 1
            };
        }
        crc
    }
    let mut crc: u32 = 0;
    for &byte in data {
        crc = advance(crc, byte);
    }
    let mut length = data.len();
    while length > 0 {
        crc = advance(crc, (length & 0xff) as u8);
        length /= 256;
    }
    !crc
}

pub fn legacy_log_path(harness: &Path, repo_dir: &str) -> PathBuf {
    harness
        .join(".tmp")
        .join(format!("devboard-{}.log", posix_cksum(repo_dir.as_bytes())))
}

fn real_path(path: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(path).ok()
}

/// Resolves the harness that serves an instance from its STATIC_DIR or cwd.
pub fn serving_harness(process: &ProcessSnapshot) -> Option<PathBuf> {
    if let Some(static_dir) = process.env.get("STATIC_DIR") {
        if let Some(harness) = Path::new(static_dir).parent().and_then(real_path) {
            return Some(harness);
        }
    }
    process.cwd.as_deref().and_then(real_path)
}

/// True when a dashboard serves a repository inside a harness verification
/// scratch root: `<anything>/.devboard/.tmp` for the verification scripts, or
/// `<anything>/.devboard/.test-tmp` for the crate test suite's fixtures.
///
/// A fixture is invisible even though it looks like a real host, because the
/// test that started it deletes it and its deliberate release, install, and
/// server failures prove an assertion. `supervision::is_verification_scratch`
/// answers the other question — whether an orphan is safe to reap — and
/// deliberately excludes the test root, so the two predicates stay separate.
fn is_fixture_repository(repo_dir: &str) -> bool {
    let segments: Vec<&str> = repo_dir
        .split(['/', '\\'])
        .filter(|segment| !segment.is_empty())
        .collect();
    segments.iter().enumerate().any(|(index, segment)| {
        *segment == ".devboard"
            && matches!(
                segments.get(index + 1),
                Some(next) if *next == ".tmp" || *next == ".test-tmp"
            )
    })
}

/// The local release directory override the verification scripts set.
const RELEASE_FIXTURE_ENV: &str = "DEVBOARD_RELEASE_DIR";

/// True when a dashboard belongs to verification.
pub fn is_verification_fixture(repo_dir: &str, env: &HashMap<String, String>) -> bool {
    let release_dir = env.get(RELEASE_FIXTURE_ENV);
    is_fixture_repository(repo_dir) || release_dir.is_some_and(|value| !value.is_empty())
}

/// The live watchdog verification seeds a scratch dashboard on purpose.
const WATCHDOG_FIXTURE_ENV: &str = "DEVBOARD_WATCHDOG_FIXTURE";

/// `Number(value)` for an environment value, `None` for NaN.
fn number(value: &str) -> Option<f64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    trimmed.parse::<f64>().ok()
}

/// Builds instances from a process table.
pub fn instances_from_processes(
    processes: &[ProcessSnapshot],
    self_pids: &HashSet<u32>,
) -> Vec<Instance> {
    instances_from_processes_including(processes, self_pids, None)
}

/// One `devboard serve` command line's own arguments.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct ServeArguments {
    repo_dir: Option<String>,
    port: Option<u32>,
    state_dir: Option<String>,
}

/// The arguments of a `devboard serve` command line, or `None` when the
/// process is not one.
fn rust_serve_arguments(cmdline: &str) -> Option<ServeArguments> {
    let tokens: Vec<&str> = cmdline.split_whitespace().collect();
    let binary = tokens.iter().position(|token| {
        crate::supervision::ends_with_segment(token, "devboard")
            || crate::supervision::ends_with_segment(token, "devboard.exe")
    })?;
    if tokens.get(binary + 1) != Some(&"serve") {
        return None;
    }
    let mut arguments = ServeArguments::default();
    let mut index = binary + 2;
    while index < tokens.len() {
        match tokens[index] {
            "--repo-dir" => {
                arguments.repo_dir = tokens.get(index + 1).map(|value| value.to_string());
                index += 2;
            }
            "--port" => {
                arguments.port = tokens
                    .get(index + 1)
                    .and_then(|value| value.parse::<u32>().ok());
                index += 2;
            }
            "--state-dir" => {
                arguments.state_dir = tokens.get(index + 1).map(|value| value.to_string());
                index += 2;
            }
            "--adrs-dir" | "--static-dir" | "--token" => index += 2,
            _ => index += 1,
        }
    }
    Some(arguments)
}

/// The harness tree a `devboard` program path sits in: `<prefix>/bin/devboard`
/// or `<checkout>/.devboard/target/<profile>/devboard`.
fn program_harness(cmdline: &str) -> Option<PathBuf> {
    let program = cmdline.split_whitespace().next()?;
    let path = Path::new(program);
    for ancestor in path.ancestors() {
        if ancestor.file_name().and_then(|name| name.to_str()) == Some(".devboard") {
            return real_path(ancestor);
        }
    }
    None
}

/// Builds instances from a process table, keeping a verification fixture when
/// it serves `include_repo` exactly.
pub fn instances_from_processes_including(
    processes: &[ProcessSnapshot],
    self_pids: &HashSet<u32>,
    include_repo: Option<&Path>,
) -> Vec<Instance> {
    let mut ordered: Vec<&ProcessSnapshot> = processes.iter().collect();
    ordered.sort_by_key(|process| process.pid);
    let mut seen = HashSet::new();
    let mut instances = Vec::new();
    for process in ordered {
        if self_pids.contains(&process.pid) {
            continue;
        }
        // Only a dashboard counts; a worker descendant never matches the
        // `serve` command line, so a dashboard started by this process (a test
        // launcher, a replacement) is still discovered.
        let serve = rust_serve_arguments(&process.cmdline);
        if serve.is_none() && !process.cmdline.contains("server/index.ts") {
            continue;
        }
        let serve = serve.unwrap_or_default();
        let Some(repo_dir) = serve
            .repo_dir
            .or_else(|| process.env.get("REPO_DIR").cloned())
        else {
            continue;
        };
        let port = match serve.port {
            Some(port) => port as f64,
            None => {
                let Some(port) = process.env.get("PORT").and_then(|value| number(value)) else {
                    continue;
                };
                port
            }
        };
        let included =
            include_repo.is_some_and(|root| real_path(root) == real_path(Path::new(&repo_dir)));
        if is_verification_fixture(&repo_dir, &process.env)
            && process.env.get(WATCHDOG_FIXTURE_ENV).map(String::as_str) != Some("1")
            && !included
        {
            continue;
        }
        let Some(harness) = program_harness(&process.cmdline).or_else(|| serving_harness(process))
        else {
            continue;
        };
        let key = format!("{}\u{0}{}", repo_dir, port as u32);
        if !seen.insert(key) {
            continue;
        }
        let state_dir = serve
            .state_dir
            .map(PathBuf::from)
            .or_else(|| process.env.get("STATE_DIR").map(PathBuf::from))
            .unwrap_or_else(|| harness.join(".tmp"));
        // A dashboard started with an ephemeral port records the bound one in
        // its own marker; the command line still names `0`.
        let port = if port == 0.0 {
            marker_port(&state_dir, process.pid)
                .map(f64::from)
                .unwrap_or(0.0)
        } else {
            port
        };
        if port.fract() != 0.0 || port <= 0.0 {
            continue;
        }
        let journal = journal_file(&state_dir, Path::new(&repo_dir));
        let legacy = legacy_log_path(&harness, &repo_dir);
        instances.push(Instance {
            pid: process.pid,
            port: port as u32,
            repo_dir: repo_dir.clone(),
            host: process
                .env
                .get("HOST")
                .cloned()
                .unwrap_or_else(|| "127.0.0.1".to_string()),
            harness: harness.to_string_lossy().into_owned(),
            state_dir: state_dir.to_string_lossy().into_owned(),
            token: process
                .env
                .get("DEVBOARD_DASHBOARD_TOKEN")
                .cloned()
                .unwrap_or_default(),
            journal: journal.to_string_lossy().into_owned(),
            instrumented: state_dir.join("journal").exists(),
            legacy_log: legacy
                .exists()
                .then(|| legacy.to_string_lossy().into_owned()),
        });
    }
    instances
}

/// The port one dashboard's own version marker records for `pid`.
fn marker_port(state_dir: &Path, pid: u32) -> Option<u16> {
    let text = std::fs::read_to_string(state_dir.join("version.json")).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    if value.get("pid").and_then(Value::as_u64) != Some(pid as u64) {
        return None;
    }
    value
        .get("port")
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port > 0)
}

/// Every dashboard on the machine, read from `/proc`.
pub fn discover_instances() -> Vec<Instance> {
    let self_pids = HashSet::from([std::process::id()]);
    instances_from_processes(&process_table(), &self_pids)
}

/// Every dashboard on the machine, plus the one serving `root` even when that
/// repository is a verification fixture.
pub fn discover_instances_for(root: &Path) -> Vec<Instance> {
    let self_pids = HashSet::from([std::process::id()]);
    instances_from_processes_including(&process_table(), &self_pids, Some(root))
}

// ---------------------------------------------------------------------------
// Age-based retention
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CleanupSource {
    Canonical,
    Sibling,
    Instance,
}

impl CleanupSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Canonical => "canonical",
            Self::Sibling => "sibling",
            Self::Instance => "instance",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoveredStateDir {
    pub state_dir: PathBuf,
    pub source: CleanupSource,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CleanupCandidateKind {
    File,
    Symlink,
    Directory,
}

impl CleanupCandidateKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Symlink => "symlink",
            Self::Directory => "directory",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CleanupCandidate {
    pub path: PathBuf,
    pub bytes: u64,
    pub kind: CleanupCandidateKind,
}

#[derive(Clone, Debug)]
pub struct CleanupRootReport {
    pub state_dir: PathBuf,
    pub source: CleanupSource,
    /// Everything eligible under this directory, whether or not it was removed.
    pub candidates: Vec<CleanupCandidate>,
    /// What the run removed; empty in a dry run.
    pub removed: Vec<CleanupCandidate>,
    /// Bytes removed, or bytes a dry run would remove.
    pub bytes: u64,
    pub files: u64,
    pub directories: u64,
    pub errors: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct CleanupReport {
    pub now: String,
    pub cutoff: String,
    pub dry_run: bool,
    pub roots: Vec<CleanupRootReport>,
}

fn real_directory(path: &Path) -> Option<PathBuf> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.is_dir() {
        return None;
    }
    std::fs::canonicalize(path).ok()
}

/// The state directories one sweep covers: the canonical harness, every direct
/// sibling `<host>/.devboard/.tmp`, and every live dashboard's real state
/// directory.
pub fn covered_state_dirs(root: &Path, instances: &[Instance]) -> Vec<CoveredStateDir> {
    let mut covered: Vec<CoveredStateDir> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut add = |path: &Path, source: CleanupSource, covered: &mut Vec<CoveredStateDir>| {
        let Some(real) = real_directory(path) else {
            return;
        };
        if !seen.insert(real.clone()) {
            return;
        }
        covered.push(CoveredStateDir {
            state_dir: real,
            source,
        });
    };
    add(
        &root.join(".devboard").join(".tmp"),
        CleanupSource::Canonical,
        &mut covered,
    );
    let parent = root.parent();
    let mut names: Vec<String> = parent
        .and_then(|directory| std::fs::read_dir(directory).ok())
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    if let Some(parent) = parent {
        for name in names {
            add(
                &parent.join(name).join(".devboard").join(".tmp"),
                CleanupSource::Sibling,
                &mut covered,
            );
        }
    }
    for instance in instances {
        let state_dir = if instance.state_dir.is_empty() {
            Path::new(&instance.journal)
                .parent()
                .and_then(Path::parent)
                .map(Path::to_path_buf)
                .unwrap_or_default()
        } else {
            PathBuf::from(&instance.state_dir)
        };
        add(&state_dir, CleanupSource::Instance, &mut covered);
    }
    covered
}

/// True when a lock file's name records a pid that is still alive.
fn live_legacy_lock(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let Some(rest) = name
        .strip_prefix("devboard-")
        .and_then(|rest| rest.strip_suffix(".lock"))
    else {
        return false;
    };
    if rest.is_empty() || !rest.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    Path::new(&format!("/proc/{rest}")).exists()
}

fn inside(directory: &Path, path: &Path) -> bool {
    match path.strip_prefix(directory) {
        Ok(rest) => !rest.as_os_str().is_empty(),
        Err(_) => false,
    }
}

/// True when `name` is a repository's 24-hex journal key.
fn is_repo_state_directory_name(name: &str) -> bool {
    name.len() == REPO_STATE_DIRECTORY_LEN
        && name
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// True when a static snapshot directory name still names a running process.
fn snapshot_in_use(name: &str) -> bool {
    let Some((pid, _)) = name.split_once('-') else {
        return false;
    };
    if pid.is_empty() || !pid.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    pid.parse::<u32>().map(pid_alive).unwrap_or(false)
}

fn path_starts_with(path: &Path, prefix: &Path) -> bool {
    path.starts_with(prefix)
}

fn sweep_visit(
    directory: &Path,
    path: &Path,
    cutoff: i64,
    watchdog_run_dir: Option<&Path>,
    report: &mut CleanupRootReport,
) -> (bool, u64) {
    if is_protected(directory, path, watchdog_run_dir) {
        return (false, 0);
    }
    let Ok(entry) = std::fs::symlink_metadata(path) else {
        report
            .errors
            .push(format!("{}: could not read", path.display()));
        return (false, 0);
    };
    let Ok(modified) = entry.modified() else {
        return (false, 0);
    };
    let mtime = modified
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    if entry.file_type().is_symlink() {
        if mtime < cutoff {
            report.candidates.push(CleanupCandidate {
                path: path.to_path_buf(),
                bytes: 0,
                kind: CleanupCandidateKind::Symlink,
            });
            return (true, 0);
        }
        return (false, 0);
    }
    if entry.is_file() {
        if mtime < cutoff {
            report.candidates.push(CleanupCandidate {
                path: path.to_path_buf(),
                bytes: entry.len(),
                kind: CleanupCandidateKind::File,
            });
            return (true, entry.len());
        }
        return (false, 0);
    }
    if !entry.is_dir() {
        return (false, 0);
    }
    let mut names: Vec<std::ffi::OsString> = match std::fs::read_dir(path) {
        Ok(entries) => entries.flatten().map(|entry| entry.file_name()).collect(),
        Err(_) => {
            report
                .errors
                .push(format!("{}: could not read", path.display()));
            return (false, 0);
        }
    };
    names.sort();
    let mut survivors = 0;
    let mut bytes = 0;
    for name in names {
        let (removable, child_bytes) = sweep_visit(
            directory,
            &path.join(name),
            cutoff,
            watchdog_run_dir,
            report,
        );
        bytes += child_bytes;
        if !removable {
            survivors += 1;
        }
    }
    if survivors == 0 && mtime < cutoff {
        report.candidates.push(CleanupCandidate {
            path: path.to_path_buf(),
            bytes: 0,
            kind: CleanupCandidateKind::Directory,
        });
        return (true, bytes);
    }
    (false, bytes)
}

/// One state directory. Every file or symlink older than the cutoff is a
/// candidate; a directory is one when it would be empty and its own mtime,
/// read before any deletion, is older.
pub fn sweep_state_dir(
    state_dir: &Path,
    now_ms: i64,
    dry_run: bool,
    watchdog_run_dir: Option<&Path>,
) -> CleanupRootReport {
    let cutoff = now_ms - CLEANUP_RETENTION_MS;
    let mut report = CleanupRootReport {
        state_dir: state_dir.to_path_buf(),
        source: CleanupSource::Canonical,
        candidates: Vec::new(),
        removed: Vec::new(),
        bytes: 0,
        files: 0,
        directories: 0,
        errors: Vec::new(),
    };
    let Some(directory) = real_directory(state_dir) else {
        report
            .errors
            .push("not a directory; nothing swept".to_string());
        return report;
    };
    report.state_dir = directory.clone();
    let mut top: Vec<std::ffi::OsString> = match std::fs::read_dir(&directory) {
        Ok(entries) => entries.flatten().map(|entry| entry.file_name()).collect(),
        Err(_) => {
            report
                .errors
                .push(format!("{}: could not read", directory.display()));
            return report;
        }
    };
    top.sort();
    for name in top {
        sweep_visit(
            &directory,
            &directory.join(name),
            cutoff,
            watchdog_run_dir,
            &mut report,
        );
    }

    let total: u64 = report
        .candidates
        .iter()
        .map(|candidate| candidate.bytes)
        .sum();
    if dry_run {
        report.bytes = total;
        report.files = report
            .candidates
            .iter()
            .filter(|candidate| candidate.kind != CleanupCandidateKind::Directory)
            .count() as u64;
        report.directories = report
            .candidates
            .iter()
            .filter(|candidate| candidate.kind == CleanupCandidateKind::Directory)
            .count() as u64;
        return report;
    }
    let candidates = std::mem::take(&mut report.candidates);
    for candidate in candidates {
        if !inside(&directory, &candidate.path) {
            report.errors.push(format!(
                "{}: refuses to delete outside {}",
                candidate.path.display(),
                directory.display()
            ));
            continue;
        }
        let removed = if candidate.kind == CleanupCandidateKind::Directory {
            std::fs::remove_dir(&candidate.path)
        } else {
            std::fs::remove_file(&candidate.path)
        };
        match removed {
            Ok(()) => {
                if candidate.kind == CleanupCandidateKind::Directory {
                    report.directories += 1;
                } else {
                    report.files += 1;
                }
                report.bytes += candidate.bytes;
                report.removed.push(candidate);
            }
            Err(error) => {
                report
                    .errors
                    .push(format!("{}: {}", candidate.path.display(), error));
            }
        }
    }
    report
}

fn is_protected(directory: &Path, path: &Path, watchdog_run_dir: Option<&Path>) -> bool {
    let watchdog = directory.join("watchdog");
    let exact: HashSet<PathBuf> = [
        watchdog.join("state.json"),
        watchdog.join("latest.json"),
        watchdog.join("lock"),
        watchdog.join("cycle-claim.json"),
        watchdog.join("worker.json"),
        watchdog.join("settings.json"),
        watchdog.join("projection.json"),
        directory.join("orchestrator").join("state.json"),
        directory.join("orchestrator").join("ledger.json"),
        directory.join("orchestrator").join("lock"),
    ]
    .into_iter()
    .collect();
    if exact.contains(path) {
        return true;
    }
    let serving = directory.join("serving");
    if let Ok(rest) = path.strip_prefix(&serving) {
        if let Some(first) = rest.components().next() {
            if snapshot_in_use(&first.as_os_str().to_string_lossy()) {
                return true;
            }
        }
    }
    if live_legacy_lock(path) {
        return true;
    }
    let base = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let watchdog_lock_prefix = format!(
        "{}{}lock.",
        watchdog.to_string_lossy(),
        std::path::MAIN_SEPARATOR
    );
    if (base == "lock" || path.to_string_lossy().starts_with(&watchdog_lock_prefix))
        && live_lock_owner(path).is_some()
    {
        return true;
    }
    let scout = directory.join("scout");
    if let Ok(rest) = path.strip_prefix(&scout) {
        if let Some(first) = rest.components().next() {
            if is_repo_state_directory_name(&first.as_os_str().to_string_lossy()) {
                return true;
            }
        }
    }
    let design = directory.join("design");
    if let Ok(rest) = path.strip_prefix(&design) {
        if let Some(first) = rest.components().next() {
            if is_repo_state_directory_name(&first.as_os_str().to_string_lossy()) {
                return true;
            }
        }
    }
    // The daily complexity snapshots and every background worker's own state
    // are durable per-repository records; no age makes them cleanup
    // candidates.
    for durable in [
        "complexity",
        "api-standards",
        "dead-code",
        "single-responsibility",
        "consistent-naming",
        "mcp-optimizer",
        "release-train",
    ] {
        let root = directory.join(durable);
        if let Ok(rest) = path.strip_prefix(&root) {
            if let Some(first) = rest.components().next() {
                if is_repo_state_directory_name(&first.as_os_str().to_string_lossy()) {
                    return true;
                }
            }
        }
    }
    if base == "providers"
        && (path.join("credentials.json").exists() || path.join("agents").is_dir())
    {
        return true;
    }
    let mut prefixes: Vec<PathBuf> = [
        "state",
        "journal",
        "providers",
        "issues",
        "flow",
        "coach",
        "goal-drafts",
    ]
    .into_iter()
    .map(|name| directory.join(name))
    .collect();
    prefixes.push(directory.join("watchdog").join("control"));
    prefixes.push(directory.join("watchdog").join("workers"));
    if let Some(run_dir) = watchdog_run_dir {
        prefixes.push(absolute(run_dir));
    }
    prefixes.iter().any(|prefix| path_starts_with(path, prefix))
}

/// Finds every covered state directory and sweeps each one.
pub fn run_cleanup(
    root: &Path,
    now_ms: i64,
    dry_run: bool,
    instances: &[Instance],
    covered: Option<&[CoveredStateDir]>,
    watchdog_run_dir: Option<&Path>,
) -> CleanupReport {
    let owned;
    let entries: &[CoveredStateDir] = match covered {
        Some(entries) => entries,
        None => {
            owned = covered_state_dirs(root, instances);
            &owned
        }
    };
    let roots = entries
        .iter()
        .map(|entry| {
            let mut report = sweep_state_dir(&entry.state_dir, now_ms, dry_run, watchdog_run_dir);
            report.source = entry.source;
            report
        })
        .collect();
    CleanupReport {
        now: iso_from_ms(now_ms),
        cutoff: iso_from_ms(now_ms - CLEANUP_RETENTION_MS),
        dry_run,
        roots,
    }
}

// ---------------------------------------------------------------------------
// Journal retention
// ---------------------------------------------------------------------------

/// A journal filename: `<24-hex project key>.jsonl`, rotated aside as
/// `<key>.jsonl.<rotation instant>-<counter>`.
fn parse_journal_name(name: &str) -> Option<(String, Option<(u64, u64)>)> {
    let (key, rest) = match name.split_once(".jsonl") {
        Some((key, rest)) => (key, rest),
        None => return None,
    };
    if !is_repo_state_directory_name(key) {
        return None;
    }
    if rest.is_empty() {
        return Some((key.to_string(), None));
    }
    let rest = rest.strip_prefix('.')?;
    let (ms, counter) = rest.split_once('-')?;
    if ms.is_empty()
        || counter.is_empty()
        || !ms.bytes().all(|byte| byte.is_ascii_digit())
        || !counter.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    Some((
        key.to_string(),
        Some((ms.parse().ok()?, counter.parse().ok()?)),
    ))
}

/// Every journal file of one project: rotated journals oldest first, then the
/// live file.
pub fn journal_files(live_path: &Path, since_ms: Option<i64>) -> Vec<PathBuf> {
    let (Some(directory), Some(base)) = (live_path.parent(), live_path.file_name()) else {
        return vec![live_path.to_path_buf()];
    };
    let base = base.to_string_lossy();
    let Some((live_key, _)) = parse_journal_name(&base) else {
        return vec![live_path.to_path_buf()];
    };
    let Ok(entries) = std::fs::read_dir(directory) else {
        return vec![live_path.to_path_buf()];
    };
    let mut rotated: Vec<(i64, u64, String, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some((key, rotation)) = parse_journal_name(&name) else {
            continue;
        };
        if key != live_key {
            continue;
        }
        let Some((ms, counter)) = rotation else {
            continue;
        };
        let path = directory.join(&name);
        if let Some(cutoff) = since_ms {
            match modified_ms(&path) {
                Some(modified) if modified >= cutoff => {}
                _ => continue,
            }
        }
        rotated.push((ms as i64, counter, name, path));
    }
    rotated.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then(left.1.cmp(&right.1))
            .then(left.2.cmp(&right.2))
    });
    let mut files: Vec<PathBuf> = rotated.into_iter().map(|entry| entry.3).collect();
    files.push(live_path.to_path_buf());
    files
}

/// Drops rotated journals past the retention limit and enforces the total
/// bound by deleting the oldest complete files first.
pub fn prune_journal(
    state_dir: &Path,
    now_ms: i64,
    window_start_ms: i64,
    retention_ms: i64,
    max_bytes: u64,
) -> Vec<String> {
    let directory = state_dir.join("journal");
    let Ok(entries) = std::fs::read_dir(&directory) else {
        return Vec::new();
    };
    struct JournalFile {
        path: PathBuf,
        name: String,
        size: u64,
        mtime_ms: i64,
        live: bool,
    }
    let mut files: Vec<JournalFile> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some((_, rotation)) = parse_journal_name(&name) else {
            continue;
        };
        let path = directory.join(&name);
        let Ok(metadata) = std::fs::metadata(&path) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let Some(mtime_ms) = modified_ms(&path) else {
            continue;
        };
        files.push(JournalFile {
            path,
            name,
            size: metadata.len(),
            mtime_ms,
            live: rotation.is_none(),
        });
    }
    files.sort_by(|left, right| left.mtime_ms.cmp(&right.mtime_ms));
    let mut removed = Vec::new();
    let cutoff = now_ms - retention_ms;
    let mut remaining: HashSet<usize> = (0..files.len()).collect();
    for (index, file) in files.iter().enumerate() {
        if file.live || file.mtime_ms >= cutoff {
            continue;
        }
        if std::fs::remove_file(&file.path).is_ok() {
            remaining.remove(&index);
            removed.push(file.name.clone());
        }
    }
    let mut total: u64 = remaining.iter().map(|index| files[*index].size).sum();
    for (index, file) in files.iter().enumerate() {
        if total <= max_bytes {
            break;
        }
        if !remaining.contains(&index) || file.live || file.mtime_ms >= window_start_ms {
            continue;
        }
        if std::fs::remove_file(&file.path).is_ok() {
            remaining.remove(&index);
            total -= file.size;
            removed.push(file.name.clone());
        }
    }
    removed
}

/// Prunes one state directory's journals at a cycle's default bounds.
pub fn prune_journals(state_dir: &Path, now_ms: i64, window_start_ms: i64) -> Vec<String> {
    prune_journal(
        state_dir,
        now_ms,
        window_start_ms,
        JOURNAL_RETENTION_MS,
        JOURNAL_MAX_BYTES,
    )
}

// ---------------------------------------------------------------------------
// Evidence collection
// ---------------------------------------------------------------------------

/// The journal record kinds the debugger and watchdog distinguish.
pub const JOURNAL_KINDS: &[&str] = &[
    "activity",
    "question",
    "run-start",
    "run-stop",
    "lane-start",
    "lane-stop",
    "lifecycle",
    "acp-stderr",
    "server-error",
    "update",
    "update-error",
];

/// An inclusive evidence window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Window {
    pub start_ms: i64,
    pub end_ms: i64,
}

impl Window {
    pub fn start_iso(&self) -> String {
        iso_from_ms(self.start_ms)
    }

    pub fn end_iso(&self) -> String {
        iso_from_ms(self.end_ms)
    }

    pub fn contains(&self, instant: i64) -> bool {
        instant >= self.start_ms && instant <= self.end_ms
    }
}

/// One piece of machine-checkable evidence.
#[derive(Clone, Debug)]
pub struct EvidenceEvent {
    /// File the evidence came from.
    pub source: String,
    /// A journal kind, or `omp-log` for omp's own process log.
    pub kind: String,
    /// ISO timestamp used for the window decision.
    pub ts: String,
    /// The same instant in epoch milliseconds.
    pub ts_ms: i64,
    pub text: String,
    /// Logical run, lane, or peer the journal record named.
    pub scope: Option<String>,
    /// Severity token an `omp-log` record carried.
    pub level: Option<String>,
    /// The body an `omp-log` record carried past its message.
    pub detail: Option<String>,
    /// Project the evidence belongs to, when attribution resolved it.
    pub instance: Option<Instance>,
}

#[derive(Clone, Debug, Default)]
pub struct Collection {
    pub events: Vec<EvidenceEvent>,
    /// Records with an unparseable timestamp or malformed shape.
    pub malformed: usize,
    /// omp log lines outside every instance's working tree.
    pub unattributed: usize,
}

/// The parsed instant, or `None` when the timestamp is unusable.
pub fn parse_timestamp(value: &Value) -> Option<i64> {
    let text = value.as_str()?;
    parse_iso_ms(text)
}

fn normalized_path(root: &Path, path: &Path) -> String {
    let resolved = absolute(path);
    let base = absolute(root);
    match resolved.strip_prefix(&base) {
        Ok(rest) if !rest.as_os_str().is_empty() => rest.to_string_lossy().into_owned(),
        _ => resolved.to_string_lossy().into_owned(),
    }
}

struct JournalFileEvidence {
    events: Vec<EvidenceEvent>,
    identities: Vec<String>,
    malformed: usize,
}

/// Reads one JSONL journal file. Records inside the window are returned;
/// malformed records are counted, never guessed.
fn read_journal_file(
    path: &Path,
    window: Window,
    root: &Path,
    instance: &Instance,
) -> JournalFileEvidence {
    let Ok(source) = std::fs::read_to_string(path) else {
        return JournalFileEvidence {
            events: Vec::new(),
            identities: Vec::new(),
            malformed: 0,
        };
    };
    let normalized_source = normalized_path(root, path);
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
        let Some(ts_ms) = parse_timestamp(record.get("ts").unwrap_or(&Value::Null)) else {
            malformed += 1;
            continue;
        };
        if !window.contains(ts_ms) {
            continue;
        }
        let Some(kind) = record.get("kind").and_then(Value::as_str) else {
            continue;
        };
        if !JOURNAL_KINDS.contains(&kind) {
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
        events.push(EvidenceEvent {
            source: normalized_source.clone(),
            kind: kind.to_string(),
            ts: iso_from_ms(ts_ms),
            ts_ms,
            text: text.to_string(),
            scope: scope.clone(),
            level: None,
            detail: None,
            instance: Some(instance.clone()),
        });
        identities.push(crate::jsjson::stringify(&json!([
            ts_ms,
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

/// Reads one project's JSONL journal, live and rotated.
pub fn read_journal_evidence(
    instance: &Instance,
    window: Window,
    root: &Path,
) -> (Vec<EvidenceEvent>, usize) {
    let mut events = Vec::new();
    let mut malformed = 0;
    let mut seen: HashMap<String, usize> = HashMap::new();
    for path in journal_files(Path::new(&instance.journal), Some(window.start_ms)) {
        let file = read_journal_file(&path, window, root, instance);
        malformed += file.malformed;
        let mut occurrences: HashMap<String, usize> = HashMap::new();
        for (index, event) in file.events.into_iter().enumerate() {
            let identity = file.identities.get(index).cloned().unwrap_or_default();
            let occurrence = occurrences.get(&identity).copied().unwrap_or(0);
            occurrences.insert(identity.clone(), occurrence + 1);
            if occurrence < seen.get(&identity).copied().unwrap_or(0) {
                continue;
            }
            events.push(event);
        }
        for (identity, count) in occurrences {
            let entry = seen.entry(identity).or_insert(0);
            *entry = (*entry).max(count);
        }
    }
    (events, malformed)
}

/// omp's own process-log evidence.
pub struct OmpOptions<'a> {
    pub window: Window,
    pub logs_dir: Option<&'a Path>,
    pub instances: &'a [Instance],
    pub self_pids: &'a HashSet<u32>,
    pub process_info: Option<&'a dyn Fn(u32) -> Option<Vec<u32>>>,
}

fn describe_omp_line(record: &serde_json::Map<String, Value>) -> String {
    let parts: Vec<&str> = ["message", "error"]
        .iter()
        .filter_map(|key| record.get(*key).and_then(Value::as_str))
        .filter(|part| !part.is_empty())
        .collect();
    if parts.is_empty() {
        crate::jsjson::stringify(&Value::Object(record.clone()))
    } else {
        parts.join(": ")
    }
}

fn attribution(
    pid: u32,
    instances: &[Instance],
    process_info: &dyn Fn(u32) -> Option<Vec<u32>>,
) -> Option<Instance> {
    let ancestors = process_info(pid)?;
    instances
        .iter()
        .find(|candidate| ancestors.contains(&candidate.pid))
        .cloned()
}

/// Reads omp's own process logs.
pub fn read_omp_evidence(options: &OmpOptions<'_>) -> (Vec<EvidenceEvent>, usize, usize) {
    let default_logs = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join(".omp")
        .join("logs");
    let logs_dir = options.logs_dir.unwrap_or(&default_logs);
    let fallback = |pid: u32| process_snapshot(pid).map(|snapshot| snapshot.ancestors);
    let process_info: &dyn Fn(u32) -> Option<Vec<u32>> = match options.process_info {
        Some(info) => info,
        None => &fallback,
    };
    let Ok(entries) = std::fs::read_dir(logs_dir) else {
        return (Vec::new(), 0, 0);
    };
    let mut names: Vec<String> = entries
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with("omp.") && name.ends_with(".log"))
        .collect();
    names.sort();
    let mut malformed = 0;
    let mut unattributed = 0;
    let mut events = Vec::new();
    for name in names {
        let path = logs_dir.join(name);
        match modified_ms(&path) {
            Some(mtime) if mtime >= options.window.start_ms => {}
            _ => continue,
        }
        let Ok(source) = std::fs::read_to_string(&path) else {
            continue;
        };
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
            let Some(ts_ms) = parse_timestamp(record.get("timestamp").unwrap_or(&Value::Null))
            else {
                malformed += 1;
                continue;
            };
            if !options.window.contains(ts_ms) {
                continue;
            }
            let level = record
                .get("level")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_lowercase();
            if !matches!(level.as_str(), "error" | "warn" | "fatal") {
                continue;
            }
            let pid = match record.get("pid") {
                Some(Value::Number(number)) => number.as_f64().unwrap_or(-1.0),
                _ => -1.0,
            };
            if pid.fract() != 0.0 || pid <= 0.0 || pid > u32::MAX as f64 {
                malformed += 1;
                continue;
            }
            let pid = pid as u32;
            if options.self_pids.contains(&pid) {
                continue;
            }
            let ancestors = process_info(pid).unwrap_or_default();
            if ancestors
                .iter()
                .any(|ancestor| options.self_pids.contains(ancestor))
            {
                continue;
            }
            let Some(owner) = attribution(pid, options.instances, process_info) else {
                unattributed += 1;
                continue;
            };
            events.push(EvidenceEvent {
                source: path.to_string_lossy().into_owned(),
                kind: "omp-log".to_string(),
                ts: iso_from_ms(ts_ms),
                ts_ms,
                text: describe_omp_line(record),
                scope: None,
                level: Some(level),
                detail: record
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                instance: Some(owner),
            });
        }
    }
    (events, malformed, unattributed)
}

/// Collects the journal and omp evidence for one cycle window.
pub fn collect_evidence(
    root: &Path,
    instances: &[Instance],
    window: Window,
    self_pids: &HashSet<u32>,
    logs_dir: Option<&Path>,
    process_info: Option<&dyn Fn(u32) -> Option<Vec<u32>>>,
) -> Collection {
    let mut events = Vec::new();
    let mut malformed = 0;
    for instance in instances {
        let (journal_events, journal_malformed) = read_journal_evidence(instance, window, root);
        events.extend(journal_events);
        malformed += journal_malformed;
    }
    let (omp_events, omp_malformed, unattributed) = read_omp_evidence(&OmpOptions {
        window,
        logs_dir,
        instances,
        self_pids,
        process_info,
    });
    events.extend(omp_events);
    malformed += omp_malformed;
    Collection {
        events,
        malformed,
        unattributed,
    }
}

static TIMESTAMP_PREFIX: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^\d{4}-\d{2}-\d{2}T[^\s]+").expect("a timestamp"));
static CAPTURE_POINTER: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"\s*\braw-http-request=\S+").expect("a capture pointer"));
static WHITESPACE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"\s+").expect("whitespace"));

/// An evidence line without its timestamp, its per-occurrence capture pointer,
/// or incidental whitespace.
pub fn normalize_evidence_line(text: &str) -> String {
    let without_timestamp = TIMESTAMP_PREFIX.replace(text, "");
    let without_pointer = CAPTURE_POINTER.replace_all(&without_timestamp, "");
    WHITESPACE
        .replace_all(&without_pointer, " ")
        .trim()
        .to_string()
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/// Machine-checkable signal categories.
pub const FINDING_CATEGORIES: &[&str] = &[
    "server-error",
    "update-error",
    "acp-stderr",
    "lane-failed",
    "omp-error",
    "omp-warn",
    "omp-fatal",
    "stall",
    "question-loop",
];

fn signal_kind(kind: &str) -> Option<&'static str> {
    match kind {
        "server-error" => Some("server-error"),
        "update-error" => Some("update-error"),
        "acp-stderr" => Some("acp-stderr"),
        _ => None,
    }
}

/// One distinct signal in a window.
#[derive(Clone, Debug)]
pub struct Finding {
    pub category: String,
    /// The normalized evidence line, truncated for a report body.
    pub quote: String,
    /// Earliest event timestamp the finding was derived from.
    pub ts: String,
    /// Every dashboard that contributed the same signal.
    pub instances: Vec<Instance>,
    /// Stable identity across cycles and hosts.
    pub fingerprint: String,
}

/// `sha256(category + "\n" + normalized line)`, first 32 hex characters.
pub fn finding_fingerprint(category: &str, line: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(category.as_bytes());
    hasher.update(b"\n");
    hasher.update(normalize_evidence_line(line).as_bytes());
    let digest = hasher.finalize();
    let hex = hex::encode(&digest[..16]);
    hex.chars().take(32).collect()
}

/// The last whitespace-separated token of a `lane-stop` line is its status.
pub fn lane_status(text: &str) -> Option<&str> {
    let tokens: Vec<&str> = text.split_whitespace().collect();
    if tokens.len() < 2 {
        return None;
    }
    tokens.last().copied()
}

fn recovered_stream_warning(event: &EvidenceEvent) -> bool {
    event.kind == "omp-log"
        && event.level.as_deref() == Some("warn")
        && normalize_evidence_line(&event.text).starts_with("Thinking loop detected")
}

const PYTHON_RUNNER_STDERR: &str = "Python runner stderr";

fn traceback_exception(detail: Option<&str>) -> Option<&str> {
    let detail = detail?;
    detail
        .split('\n')
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .next_back()
}

fn interrupted_python_runner(event: &EvidenceEvent) -> bool {
    event.kind == "omp-log"
        && event.level.as_deref() == Some("warn")
        && normalize_evidence_line(&event.text) == PYTHON_RUNNER_STDERR
        && traceback_exception(event.detail.as_deref()) == Some("KeyboardInterrupt")
}

const SESSION_PERSISTENCE_ERROR: &str = "Session persistence error.";
const ENOSPC_CODE: &str = "ENOSPC";

/// A failed session append because the host filesystem is full is a host
/// resource condition, not a repository defect: the peer keeps its session in
/// memory, and no repository change can free the disk. Excluding it keeps a
/// full disk from spending the cycle's filing budget on an issue that cannot
/// be fixed and from writing further bytes to the same full disk.
fn host_storage_failure(event: &EvidenceEvent) -> bool {
    if event.kind != "omp-log" || event.level.as_deref() != Some("error") {
        return false;
    }
    let line = normalize_evidence_line(&event.text);
    line.starts_with(SESSION_PERSISTENCE_ERROR) && line.contains(ENOSPC_CODE)
}

fn event_key(event: &EvidenceEvent) -> String {
    match &event.instance {
        Some(instance) => format!("{}:{}", instance.repo_dir, instance.port),
        None => event.source.clone(),
    }
}

fn question_key(event: &EvidenceEvent) -> String {
    match &event.scope {
        Some(scope) => format!("{}\n{scope}", event_key(event)),
        None => event_key(event),
    }
}

fn stream_key(event: &EvidenceEvent) -> String {
    let text = normalize_evidence_line(&event.text);
    if event.kind.starts_with("lane-") {
        let lane = text.split_whitespace().next().unwrap_or("");
        return format!("{}\nlane\n{lane}", event_key(event));
    }
    let file = match text.find(':') {
        Some(index) => text.get(..index).unwrap_or("").trim(),
        None => "",
    };
    format!("{}\nrun\n{file}", event_key(event))
}

/// Turns a window of evidence into one finding per distinct signal.
pub fn analyze_evidence(
    events: &[EvidenceEvent],
    window: Window,
    stall_lookback: Window,
) -> Vec<Finding> {
    let mut findings: Vec<Finding> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut questions: HashMap<String, Vec<EvidenceEvent>> = HashMap::new();
    let mut starts: HashMap<String, Vec<EvidenceEvent>> = HashMap::new();
    let mut stops: HashMap<String, Vec<i64>> = HashMap::new();

    let mut add =
        |category: &str, event: &EvidenceEvent, findings: &mut Vec<Finding>| {
            let quote = normalize_evidence_line(&event.text);
            if quote.is_empty() {
                return;
            }
            let fingerprint = finding_fingerprint(category, &quote);
            if let Some(position) = index.get(&fingerprint).copied() {
                let existing = &mut findings[position];
                if event.ts < existing.ts {
                    existing.ts = event.ts.clone();
                }
                if let Some(instance) = &event.instance {
                    if !existing.instances.iter().any(|known| {
                        known.repo_dir == instance.repo_dir && known.port == instance.port
                    }) {
                        existing.instances.push(instance.clone());
                    }
                }
                return;
            }
            index.insert(fingerprint.clone(), findings.len());
            findings.push(Finding {
                category: category.to_string(),
                quote: quote.chars().take(300).collect(),
                ts: event.ts.clone(),
                instances: event.instance.iter().cloned().collect(),
                fingerprint,
            });
        };

    for event in events {
        match event.kind.as_str() {
            "question" => {
                if window.contains(event.ts_ms) {
                    questions
                        .entry(question_key(event))
                        .or_default()
                        .push(event.clone());
                }
                continue;
            }
            "run-start" | "lane-start" => {
                if stall_lookback.contains(event.ts_ms) {
                    starts
                        .entry(stream_key(event))
                        .or_default()
                        .push(event.clone());
                }
                continue;
            }
            "run-stop" | "lane-stop" => {
                if !stall_lookback.contains(event.ts_ms) {
                    continue;
                }
                let key = stream_key(event);
                stops.entry(key).or_default().push(event.ts_ms);
                if event.kind == "lane-stop"
                    && event.ts_ms >= window.start_ms
                    && lane_status(&event.text) == Some("failed")
                {
                    add("lane-failed", event, &mut findings);
                }
                continue;
            }
            _ => {}
        }
        if !window.contains(event.ts_ms) {
            continue;
        }
        if event.kind == "omp-log" {
            if let Some(level) = event.level.as_deref() {
                if !recovered_stream_warning(event)
                    && !interrupted_python_runner(event)
                    && !host_storage_failure(event)
                {
                    add(&format!("omp-{level}"), event, &mut findings);
                }
            }
            continue;
        }
        if let Some(category) = signal_kind(&event.kind) {
            add(category, event, &mut findings);
        }
    }

    for list in questions.values() {
        if list.len() < QUESTION_LOOP_COUNT {
            continue;
        }
        if let Some(last) = list.last() {
            add("question-loop", last, &mut findings);
        }
    }

    let stall_cutoff = window.end_ms - STALL_MS;
    for (key, list) in &starts {
        let finished = stops.get(key).cloned().unwrap_or_default();
        for event in list {
            if event.ts_ms > stall_cutoff {
                continue;
            }
            if finished.iter().any(|stopped| *stopped >= event.ts_ms) {
                continue;
            }
            add("stall", event, &mut findings);
        }
    }

    findings.sort_by(|left, right| {
        left.ts
            .cmp(&right.ts)
            .then(left.category.cmp(&right.category))
            .then(left.fingerprint.cmp(&right.fingerprint))
    });
    findings
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LedgerInstance {
    pub repo_dir: String,
    pub port: u32,
    pub pid: u32,
    pub journal: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LedgerEntry {
    pub category: String,
    /// Last observed normalized evidence line.
    pub line: String,
    pub first_seen: String,
    pub last_seen: String,
    pub count: i64,
    /// `filed:<url>`, `duplicate:<url>`, or `none`.
    pub disposition: String,
    pub url: Option<String>,
    pub filed_at: Option<String>,
    pub last_comment_at: Option<String>,
    /// The open issue the deduplication agent matched.
    pub duplicate_of: Option<String>,
    pub matched_at: Option<String>,
    pub instances: Vec<LedgerInstance>,
}

#[derive(Clone, Debug)]
pub struct Ledger {
    /// Findings in file order; the map the JSON writer emits.
    pub findings: Vec<(String, LedgerEntry)>,
    pub pending_filing: Vec<String>,
}

impl Ledger {
    pub fn get(&self, fingerprint: &str) -> Option<&LedgerEntry> {
        self.findings
            .iter()
            .find(|(key, _)| key == fingerprint)
            .map(|(_, entry)| entry)
    }

    fn get_mut(&mut self, fingerprint: &str) -> Option<&mut LedgerEntry> {
        self.findings
            .iter_mut()
            .find(|(key, _)| key == fingerprint)
            .map(|(_, entry)| entry)
    }

    fn insert(&mut self, fingerprint: String, entry: LedgerEntry) {
        self.findings.push((fingerprint, entry));
    }

    pub fn remove_pending(&mut self, fingerprint: &str) {
        self.pending_filing.retain(|pending| pending != fingerprint);
    }

    pub fn to_json(&self) -> Value {
        let mut findings = serde_json::Map::new();
        for (fingerprint, entry) in &self.findings {
            let mut row = serde_json::Map::new();
            row.insert("category".into(), json!(entry.category));
            row.insert("line".into(), json!(entry.line));
            row.insert("firstSeen".into(), json!(entry.first_seen));
            row.insert("lastSeen".into(), json!(entry.last_seen));
            row.insert("count".into(), json!(entry.count));
            row.insert("disposition".into(), json!(entry.disposition));
            if let Some(url) = &entry.url {
                row.insert("url".into(), json!(url));
            }
            if let Some(duplicate_of) = &entry.duplicate_of {
                row.insert("duplicateOf".into(), json!(duplicate_of));
            }
            if let Some(filed_at) = &entry.filed_at {
                row.insert("filedAt".into(), json!(filed_at));
            }
            if let Some(last_comment_at) = &entry.last_comment_at {
                row.insert("lastCommentAt".into(), json!(last_comment_at));
            }
            if let Some(matched_at) = &entry.matched_at {
                row.insert("matchedAt".into(), json!(matched_at));
            }
            let instances: Vec<Value> = entry
                .instances
                .iter()
                .map(|instance| {
                    json!({
                        "repoDir": instance.repo_dir,
                        "port": instance.port,
                        "pid": instance.pid,
                        "journal": instance.journal,
                    })
                })
                .collect();
            row.insert("instances".into(), json!(instances));
            findings.insert(fingerprint.clone(), Value::Object(row));
        }
        json!({
            "version": LEDGER_VERSION,
            "findings": findings,
            "pendingFiling": self.pending_filing,
        })
    }
}

/// The version 2 ledger, used when no file exists or the file is unusable.
pub fn empty_ledger() -> Ledger {
    Ledger {
        findings: Vec::new(),
        pending_filing: Vec::new(),
    }
}

fn parse_ledger_entry(value: &Value) -> Option<LedgerEntry> {
    let record = value.as_object()?;
    let disposition = record
        .get("disposition")
        .and_then(Value::as_str)
        .unwrap_or("");
    if disposition != "none"
        && !disposition.starts_with("filed:")
        && !disposition.starts_with("duplicate:")
    {
        return None;
    }
    let url = match record.get("url").and_then(Value::as_str) {
        Some(url) => Some(url.to_string()),
        None => disposition.strip_prefix("filed:").map(str::to_string),
    };
    if disposition.starts_with("filed:") && url.as_deref().unwrap_or("").is_empty() {
        return None;
    }
    let duplicate_of = match disposition.strip_prefix("duplicate:") {
        Some(url) => Some(url.to_string()),
        None => record
            .get("duplicateOf")
            .and_then(Value::as_str)
            .map(str::to_string),
    };
    if disposition.starts_with("duplicate:") && duplicate_of.as_deref().unwrap_or("").is_empty() {
        return None;
    }
    let category = record.get("category")?.as_str()?.to_string();
    let line = record.get("line")?.as_str()?.to_string();
    let first_seen = record.get("firstSeen")?.as_str()?.to_string();
    let last_seen = record.get("lastSeen")?.as_str()?.to_string();
    let count = match record.get("count").and_then(Value::as_f64) {
        Some(count) if count.is_finite() && count > 0.0 => count as i64,
        _ => 1,
    };
    let mut instances = Vec::new();
    if let Some(rows) = record.get("instances").and_then(Value::as_array) {
        for row in rows {
            let Some(instance) = row.as_object() else {
                continue;
            };
            let (Some(repo_dir), Some(journal)) = (
                instance.get("repoDir").and_then(Value::as_str),
                instance.get("journal").and_then(Value::as_str),
            ) else {
                continue;
            };
            let port = instance.get("port").and_then(Value::as_f64);
            let pid = instance.get("pid").and_then(Value::as_f64);
            let (Some(port), Some(pid)) = (port, pid) else {
                continue;
            };
            if port.fract() != 0.0 || pid.fract() != 0.0 {
                continue;
            }
            instances.push(LedgerInstance {
                repo_dir: repo_dir.to_string(),
                port: port as u32,
                pid: pid as u32,
                journal: journal.to_string(),
            });
        }
    }
    Some(LedgerEntry {
        category,
        line,
        first_seen,
        last_seen,
        count,
        disposition: disposition.to_string(),
        url,
        filed_at: record
            .get("filedAt")
            .and_then(Value::as_str)
            .map(str::to_string),
        last_comment_at: record
            .get("lastCommentAt")
            .and_then(Value::as_str)
            .map(str::to_string),
        duplicate_of,
        matched_at: record
            .get("matchedAt")
            .and_then(Value::as_str)
            .map(str::to_string),
        instances,
    })
}

/// Reads the ledger.
pub fn load_ledger(state_dir: &Path) -> Ledger {
    let Some(parsed) = read_json(&ledger_path(state_dir)) else {
        return empty_ledger();
    };
    let Some(record) = parsed.as_object() else {
        return empty_ledger();
    };
    if json_integer(record.get("version")) != Some(LEDGER_VERSION) {
        return empty_ledger();
    }
    let mut findings: Vec<(String, LedgerEntry)> = Vec::new();
    if let Some(source) = record.get("findings").and_then(Value::as_object) {
        for (fingerprint, value) in source {
            if let Some(entry) = parse_ledger_entry(value) {
                findings.push((fingerprint.clone(), entry));
            }
        }
    }
    let mut pending: Vec<String> = Vec::new();
    if let Some(rows) = record.get("pendingFiling").and_then(Value::as_array) {
        for row in rows {
            let Some(fingerprint) = row.as_str() else {
                continue;
            };
            if !findings.iter().any(|(key, _)| key == fingerprint) {
                continue;
            }
            if !pending.iter().any(|value| value == fingerprint) {
                pending.push(fingerprint.to_string());
            }
        }
    }
    Ledger {
        findings,
        pending_filing: pending,
    }
}

pub fn save_ledger(state_dir: &Path, ledger: &Ledger) -> io::Result<()> {
    std::fs::create_dir_all(state_dir)?;
    let path = ledger_path(state_dir);
    let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    let mut text =
        serde_json::to_string_pretty(&ledger.to_json()).unwrap_or_else(|_| "null".to_string());
    text.push('\n');
    std::fs::write(&temporary, text)?;
    std::fs::rename(&temporary, path)
}

/// Records every finding in the window, creating or extending its entry.
pub fn record_findings(ledger: &mut Ledger, findings: &[Finding], now_ms: i64) {
    let stamp = iso_from_ms(now_ms);
    for finding in findings {
        let contributed: Vec<LedgerInstance> = finding
            .instances
            .iter()
            .map(|instance| LedgerInstance {
                repo_dir: instance.repo_dir.clone(),
                port: instance.port,
                pid: instance.pid,
                journal: instance.journal.clone(),
            })
            .collect();
        let exists = ledger.get(&finding.fingerprint).is_some();
        if !exists {
            ledger.insert(
                finding.fingerprint.clone(),
                LedgerEntry {
                    category: finding.category.clone(),
                    line: finding.quote.clone(),
                    first_seen: stamp.clone(),
                    last_seen: stamp.clone(),
                    count: 1,
                    disposition: "none".to_string(),
                    url: None,
                    filed_at: None,
                    last_comment_at: None,
                    duplicate_of: None,
                    matched_at: None,
                    instances: contributed,
                },
            );
            continue;
        }
        let entry = ledger
            .get_mut(&finding.fingerprint)
            .expect("the recorded entry");
        entry.category = finding.category.clone();
        entry.line = finding.quote.clone();
        entry.last_seen = stamp.clone();
        entry.count += 1;
        for instance in contributed {
            if !entry
                .instances
                .iter()
                .any(|known| known.journal == instance.journal)
            {
                entry.instances.push(instance);
            }
        }
    }
}

pub fn mark_filed(ledger: &mut Ledger, fingerprint: &str, url: &str, now_ms: i64) {
    let stamp = iso_from_ms(now_ms);
    if let Some(entry) = ledger.get_mut(fingerprint) {
        entry.disposition = format!("filed:{url}");
        entry.url = Some(url.to_string());
        entry.filed_at = Some(stamp);
    }
    ledger.remove_pending(fingerprint);
}

pub fn mark_duplicate(ledger: &mut Ledger, fingerprint: &str, url: &str, now_ms: i64) {
    let stamp = iso_from_ms(now_ms);
    if let Some(entry) = ledger.get_mut(fingerprint) {
        entry.disposition = format!("duplicate:{url}");
        entry.duplicate_of = Some(url.to_string());
        entry.matched_at = Some(stamp);
    }
    ledger.remove_pending(fingerprint);
}

pub fn mark_commented(ledger: &mut Ledger, fingerprint: &str, now_ms: i64) {
    let stamp = iso_from_ms(now_ms);
    if let Some(entry) = ledger.get_mut(fingerprint) {
        entry.last_comment_at = Some(stamp);
    }
}

/// The fingerprint is waiting for a retry until its filing succeeds.
pub fn mark_pending(ledger: &mut Ledger, fingerprint: &str) {
    if !ledger
        .pending_filing
        .iter()
        .any(|value| value == fingerprint)
    {
        ledger.pending_filing.push(fingerprint.to_string());
    }
}

// ---------------------------------------------------------------------------
// GitHub issue delivery
// ---------------------------------------------------------------------------

/// GitHub's title limit for this watchdog.
pub const TITLE_MAX: usize = 80;
/// Longest first stderr line kept as a failure reason.
pub const REASON_MAX: usize = 300;
const GH_TIMEOUT_MS: u64 = 120_000;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GhOutcome {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

/// Runs one `gh` invocation with a body on standard input.
pub type GhRun = Arc<dyn Fn(&[String], &str) -> GhOutcome + Send + Sync>;

pub fn default_gh() -> GhRun {
    Arc::new(run_gh)
}

/// Runs one `gh` invocation with a body on standard input, bounded.
pub fn run_gh(argv: &[String], stdin: &str) -> GhOutcome {
    use std::io::Write;
    let mut command = std::process::Command::new("gh");
    command
        .args(argv)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return GhOutcome {
                code: 1,
                stdout: String::new(),
                stderr: error.to_string(),
                timed_out: false,
            }
        }
    };
    if let Some(mut input) = child.stdin.take() {
        let _ = input.write_all(stdin.as_bytes());
    }
    let pid = child.id();
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(child.wait_with_output());
    });
    match receiver.recv_timeout(std::time::Duration::from_millis(GH_TIMEOUT_MS)) {
        Ok(Ok(output)) => GhOutcome {
            code: output.status.code().unwrap_or(1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            timed_out: false,
        },
        Ok(Err(error)) => GhOutcome {
            code: 1,
            stdout: String::new(),
            stderr: error.to_string(),
            timed_out: false,
        },
        Err(_) => {
            #[cfg(unix)]
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGKILL);
            }
            let _ = receiver.recv();
            GhOutcome {
                code: 1,
                stdout: String::new(),
                stderr: String::new(),
                timed_out: true,
            }
        }
    }
}

fn collapse(value: &str) -> String {
    value.split_whitespace().collect::<Vec<&str>>().join(" ")
}

fn truncate(value: &str, limit: usize) -> String {
    let single = collapse(value);
    if crate::feedback::js_len(&single) <= limit {
        return single;
    }
    let kept = crate::feedback::js_truncate(&single, limit.saturating_sub(1));
    format!("{}…", kept.trim_end())
}

/// `[watchdog] <category>: <line>`, one line, never longer than 80 characters.
pub fn watchdog_title(category: &str, line: &str) -> String {
    let title = format!("[watchdog] {category}: {}", collapse(line));
    if crate::feedback::js_len(&title) <= TITLE_MAX {
        return title;
    }
    let kept = crate::feedback::js_truncate(&title, TITLE_MAX - 1);
    format!("{}…", kept.trim_end())
}

/// The first diagnostic line of a failed `gh` call, bounded for a report.
pub fn gh_failure_reason(outcome: &GhOutcome) -> String {
    let line = outcome
        .stderr
        .split('\n')
        .chain(outcome.stdout.split('\n'))
        .map(str::trim)
        .find(|line| !line.is_empty());
    match line {
        Some(line) => truncate(line, REASON_MAX),
        None if outcome.timed_out => "gh timed out".to_string(),
        None => format!("gh exited with code {}", outcome.code),
    }
}

/// Everything one issue body or comment needs.
#[derive(Clone, Debug)]
pub struct IssueInput {
    pub category: String,
    pub fingerprint: String,
    pub line: String,
    pub first_seen: String,
    pub last_seen: String,
    pub count: i64,
    pub window: Window,
    pub instances: Vec<LedgerInstance>,
    /// The cycle report that filed this issue.
    pub report_path: String,
}

fn fence(text: &str) -> String {
    let fence_text = if text.contains("```") { "````" } else { "```" };
    format!("{fence_text}text\n{text}\n{fence_text}")
}

/// Category, identity, sightings, every contributing instance, and the report.
pub fn watchdog_body(input: &IssueInput) -> String {
    let instances = if input.instances.is_empty() {
        "No dashboard is recorded.".to_string()
    } else {
        input
            .instances
            .iter()
            .map(|instance| {
                format!(
                    "- `{}` on port {} (pid {}, journal `{}`)",
                    instance.repo_dir, instance.port, instance.pid, instance.journal
                )
            })
            .collect::<Vec<String>>()
            .join("\n")
    };
    [
        "## Watchdog finding".to_string(),
        String::new(),
        format!("- Category: `{}`", input.category),
        format!("- Fingerprint: `{}`", input.fingerprint),
        format!("- First seen: {}", input.first_seen),
        format!("- Last seen: {}", input.last_seen),
        format!("- Count: {}", input.count),
        format!(
            "- Window: {} .. {}",
            input.window.start_iso(),
            input.window.end_iso()
        ),
        String::new(),
        "### Quote".to_string(),
        String::new(),
        fence(&input.line),
        String::new(),
        "### Contributing instances".to_string(),
        String::new(),
        instances,
        String::new(),
        "### Cycle report".to_string(),
        String::new(),
        format!("`{}`", input.report_path),
        String::new(),
        "Filed by the Devboard watchdog from machine-checkable evidence. \
         It never fixes, merges, pushes, or publishes."
            .to_string(),
        String::new(),
    ]
    .join("\n")
}

/// A recurrence: the new window, the latest sighting, and the running count.
pub fn watchdog_comment(input: &IssueInput) -> String {
    [
        format!(
            "Another sighting of `{}` (`{}`).",
            input.fingerprint, input.category
        ),
        String::new(),
        format!("- Last seen: {}", input.last_seen),
        format!("- Count: {}", input.count),
        format!(
            "- Window: {} .. {}",
            input.window.start_iso(),
            input.window.end_iso()
        ),
        String::new(),
        "### Quote".to_string(),
        String::new(),
        fence(&input.line),
        String::new(),
        "Filed by the Devboard watchdog from machine-checkable evidence.".to_string(),
        String::new(),
    ]
    .join("\n")
}

fn printed_url(outcome: &GhOutcome) -> Option<String> {
    outcome
        .stdout
        .split('\n')
        .map(str::trim)
        .rev()
        .find(|line| line.starts_with("http://") || line.starts_with("https://"))
        .map(str::to_string)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DeliveryResult {
    Ok { url: String },
    Failed { reason: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CommentResult {
    Ok,
    Failed { reason: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IssueState {
    Open,
    Closed,
}

/// Issue delivery for the checkout's own forge.
pub trait WatchdogDelivery: Send + Sync {
    /// `owner/name` that receives the issue, for diagnostics.
    fn repository(&self) -> &str;
    /// True when `url` names an issue this delivery's forge serves.
    fn owns(&self, url: &str) -> bool;
    fn create(&self, input: &IssueInput) -> DeliveryResult;
    fn comment(&self, url: &str, input: &IssueInput) -> CommentResult;
    /// The issue's state; `None` when the read fails.
    fn state(&self, url: &str) -> Option<IssueState>;
}

/// Whether `url` names an issue on the GitHub host this delivery writes to.
fn github_issue_on(url: &str, host: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url.trim()) else {
        return false;
    };
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return false;
    }
    if parsed.host_str().unwrap_or("").to_lowercase() != host.to_lowercase() {
        return false;
    }
    let path = parsed.path();
    let Some(rest) = path.strip_prefix('/') else {
        return false;
    };
    let mut segments: Vec<&str> = rest.split('/').collect();
    if segments.last() == Some(&"") {
        segments.pop();
    }
    match segments.as_slice() {
        [_, _, "issues", number] => {
            !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())
        }
        _ => false,
    }
}

/// GitHub delivery through the operator's authenticated `gh`.
pub struct GithubDelivery {
    repository: String,
    host: String,
    gh: GhRun,
}

impl GithubDelivery {
    pub fn new(repository: impl Into<String>, host: impl Into<String>, gh: GhRun) -> Self {
        Self {
            repository: repository.into(),
            host: host.into(),
            gh,
        }
    }
}

impl WatchdogDelivery for GithubDelivery {
    fn repository(&self) -> &str {
        &self.repository
    }

    fn owns(&self, url: &str) -> bool {
        github_issue_on(url, &self.host)
    }

    fn create(&self, input: &IssueInput) -> DeliveryResult {
        let argv = vec![
            "issue".to_string(),
            "create".to_string(),
            "--repo".to_string(),
            self.repository.clone(),
            "--title".to_string(),
            watchdog_title(&input.category, &input.line),
            "--body-file".to_string(),
            "-".to_string(),
        ];
        let outcome = (self.gh)(&argv, &watchdog_body(input));
        if outcome.code != 0 {
            return DeliveryResult::Failed {
                reason: gh_failure_reason(&outcome),
            };
        }
        match printed_url(&outcome) {
            Some(url) => DeliveryResult::Ok { url },
            None => DeliveryResult::Failed {
                reason: "gh printed no issue URL".to_string(),
            },
        }
    }

    fn comment(&self, url: &str, input: &IssueInput) -> CommentResult {
        let argv = vec![
            "issue".to_string(),
            "comment".to_string(),
            url.to_string(),
            "--body-file".to_string(),
            "-".to_string(),
        ];
        let outcome = (self.gh)(&argv, &watchdog_comment(input));
        if outcome.code != 0 {
            return CommentResult::Failed {
                reason: gh_failure_reason(&outcome),
            };
        }
        CommentResult::Ok
    }

    fn state(&self, url: &str) -> Option<IssueState> {
        let argv = vec![
            "issue".to_string(),
            "view".to_string(),
            url.to_string(),
            "--json".to_string(),
            "state".to_string(),
        ];
        let outcome = (self.gh)(&argv, "");
        if outcome.code != 0 {
            return None;
        }
        let parsed: Value = serde_json::from_str(&outcome.stdout).ok()?;
        match parsed
            .get("state")
            .and_then(Value::as_str)?
            .to_lowercase()
            .as_str()
        {
            "open" => Some(IssueState::Open),
            "closed" => Some(IssueState::Closed),
            _ => None,
        }
    }
}

/// The checkout's origin host and `owner/name`, when it names one.
pub fn origin_repository(root: &Path) -> Option<(String, String)> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["remote", "get-url", "origin"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let remote = String::from_utf8_lossy(&output.stdout).trim().to_string();
    parse_origin(&remote)
}

fn parse_origin(remote: &str) -> Option<(String, String)> {
    let trimmed = remote.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(parsed) = url::Url::parse(trimmed) {
        let host = parsed.host_str()?.to_string();
        let path = parsed.path().trim_start_matches('/').trim_end_matches('/');
        let project = path.strip_suffix(".git").unwrap_or(path);
        let segments: Vec<&str> = project.split('/').filter(|part| !part.is_empty()).collect();
        if segments.len() < 2 {
            return None;
        }
        let name = format!(
            "{}/{}",
            segments[segments.len() - 2],
            segments[segments.len() - 1]
        );
        return Some((host, name));
    }
    // `git@host:owner/name.git`
    let (user_host, path) = trimmed.split_once(':')?;
    let host = user_host.rsplit('@').next().unwrap_or(user_host);
    let project = path.trim_end_matches('/');
    let project = project.strip_suffix(".git").unwrap_or(project);
    let segments: Vec<&str> = project.split('/').filter(|part| !part.is_empty()).collect();
    if host.is_empty() || segments.len() < 2 {
        return None;
    }
    let name = format!(
        "{}/{}",
        segments[segments.len() - 2],
        segments[segments.len() - 1]
    );
    Some((host.to_string(), name))
}

/// The delivery for the checkout's origin, or an explicit refusal.
pub fn create_watchdog_delivery(
    root: &Path,
    gh: GhRun,
) -> Result<Arc<dyn WatchdogDelivery>, String> {
    create_watchdog_delivery_with(root, gh, &crate::forge::process_environment())
}

/// `create_watchdog_delivery` with an explicit environment, so a test never
/// reads or writes the process environment.
pub fn create_watchdog_delivery_with(
    root: &Path,
    gh: GhRun,
    environment: &crate::forge::Environment,
) -> Result<Arc<dyn WatchdogDelivery>, String> {
    let Some(remote) = crate::forge::origin_forge_with(root, environment) else {
        return Err(
            "the checkout's origin does not name a supported repository at this root".to_string(),
        );
    };
    match remote.forge {
        crate::forge::Forge::GitHub => Ok(Arc::new(GithubDelivery::new(
            remote.project.clone(),
            remote.host.clone(),
            gh,
        ))),
        crate::forge::Forge::Gitea => {
            let target = crate::forge::gitea_target(Some(&remote), None, None, None, environment)
                .map_err(|error| error.message)?;
            Ok(Arc::new(GiteaDelivery::new(
                crate::gitea::GiteaTarget {
                    base_url: target.base_url,
                    project: target.project,
                    token: target.token,
                },
                gh,
            )))
        }
        crate::forge::Forge::GitLab => Err(format!(
            "the checkout's origin is {}, which the watchdog cannot file to here",
            remote.forge.as_str()
        )),
    }
}

/// Runs one async Gitea call from the delivery's synchronous surface on its
/// own thread and runtime.
fn block_on_gitea<F, T>(future: F) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, crate::gitea::GiteaError>> + Send + 'static,
    T: Send + 'static,
{
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| error.to_string())?;
        runtime.block_on(future).map_err(|error| error.to_string())
    })
    .join()
    .map_err(|_| "the Gitea call panicked".to_string())?
}

/// Gitea delivery through the REST API.
pub struct GiteaDelivery {
    target: crate::gitea::GiteaTarget,
    gh: GhRun,
}

impl GiteaDelivery {
    pub fn new(target: crate::gitea::GiteaTarget, gh: GhRun) -> Self {
        Self { target, gh }
    }

    fn issue_number(&self, url: &str) -> Option<u64> {
        let parsed = url::Url::parse(url).ok()?;
        let expected = url::Url::parse(&self.target.base_url).ok()?;
        if parsed.host_str()?.to_lowercase() != expected.host_str()?.to_lowercase() {
            return None;
        }
        let segments: Vec<&str> = parsed
            .path()
            .split('/')
            .filter(|part| !part.is_empty())
            .collect();
        let number = segments.last()?;
        if segments.len() < 2 || segments[segments.len() - 2] != "issues" {
            return None;
        }
        number.parse().ok()
    }
}

impl WatchdogDelivery for GiteaDelivery {
    fn repository(&self) -> &str {
        &self.target.project
    }

    fn owns(&self, url: &str) -> bool {
        self.issue_number(url).is_some()
    }

    fn create(&self, input: &IssueInput) -> DeliveryResult {
        let target = self.target.clone();
        let title = watchdog_title(&input.category, &input.line);
        let body = watchdog_body(input);
        let _ = &self.gh;
        match block_on_gitea(async move {
            crate::gitea::create_issue(&target, &title, &body, None, 60_000).await
        }) {
            Ok(issue) => DeliveryResult::Ok { url: issue.url },
            Err(reason) => DeliveryResult::Failed { reason },
        }
    }

    fn comment(&self, url: &str, input: &IssueInput) -> CommentResult {
        let Some(number) = self.issue_number(url) else {
            return CommentResult::Failed {
                reason: "the issue URL is not on the configured Gitea origin".to_string(),
            };
        };
        let target = self.target.clone();
        let body = watchdog_comment(input);
        match block_on_gitea(async move {
            crate::gitea::comment_issue(&target, number, &body, None, 60_000).await
        }) {
            Ok(()) => CommentResult::Ok,
            Err(reason) => CommentResult::Failed { reason },
        }
    }

    fn state(&self, url: &str) -> Option<IssueState> {
        let number = self.issue_number(url)?;
        let target = self.target.clone();
        match block_on_gitea(
            async move { crate::gitea::issue_state(&target, number, 60_000).await },
        )
        .ok()
        .flatten()
        {
            Some(true) => Some(IssueState::Open),
            Some(false) => Some(IssueState::Closed),
            None => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Deduplication gate
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DedupWindow {
    pub start: String,
    pub end: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DedupCandidate {
    pub fingerprint: String,
    pub category: String,
    pub line: String,
    pub first_seen: String,
    pub last_seen: String,
    pub count: i64,
    pub instances: Vec<LedgerInstance>,
    pub window: DedupWindow,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DedupRequest {
    pub repository: String,
    pub window: DedupWindow,
    pub candidates: Vec<DedupCandidate>,
    /// How many unique candidates this cycle may file, after the caps.
    pub filing_room: i64,
}

impl DedupRequest {
    pub fn to_json(&self) -> Value {
        let candidates: Vec<Value> = self
            .candidates
            .iter()
            .map(|candidate| {
                let instances: Vec<Value> = candidate
                    .instances
                    .iter()
                    .map(|instance| {
                        json!({
                            "repoDir": instance.repo_dir,
                            "port": instance.port,
                            "pid": instance.pid,
                            "journal": instance.journal,
                        })
                    })
                    .collect();
                json!({
                    "fingerprint": candidate.fingerprint,
                    "category": candidate.category,
                    "line": candidate.line,
                    "firstSeen": candidate.first_seen,
                    "lastSeen": candidate.last_seen,
                    "count": candidate.count,
                    "instances": instances,
                    "window": {"start": candidate.window.start, "end": candidate.window.end},
                })
            })
            .collect();
        json!({
            "repository": self.repository,
            "window": {"start": self.window.start, "end": self.window.end},
            "candidates": candidates,
            "filingRoom": self.filing_room,
        })
    }
}

/// One record the dedup peer's MCP write tools append.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DedupRecord {
    pub fingerprint: String,
    pub action: String,
    pub issue: Option<String>,
    pub representative: Option<String>,
    pub number: Option<i64>,
    pub url: Option<String>,
    pub title: Option<String>,
}

/// One deduplication turn. Tests and verification inject a deterministic
/// replacement; production uses the configured ACP peer.
pub trait DedupRunner: Send + Sync {
    fn run(&self, request: &DedupRequest, run_dir: &Path) -> Result<String, String>;
}

/// Reads the records the dedup peer's MCP write tools appended.
pub fn read_dedup_records(run_dir: &Path) -> Vec<DedupRecord> {
    let Ok(text) = std::fs::read_to_string(run_dir.join("dedup-records.jsonl")) else {
        return Vec::new();
    };
    let mut records = Vec::new();
    for line in text.split('\n') {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let Some(record) = parsed.as_object() else {
            continue;
        };
        let Some(fingerprint) = record.get("fingerprint").and_then(Value::as_str) else {
            continue;
        };
        let Some(action) = record.get("action").and_then(Value::as_str) else {
            continue;
        };
        if action != "filed" && action != "duplicate" {
            continue;
        }
        records.push(DedupRecord {
            fingerprint: fingerprint.to_string(),
            action: action.to_string(),
            issue: record
                .get("issue")
                .and_then(Value::as_str)
                .map(str::to_string),
            representative: record
                .get("representative")
                .and_then(Value::as_str)
                .map(str::to_string),
            number: record.get("number").and_then(Value::as_i64),
            url: record
                .get("url")
                .and_then(Value::as_str)
                .map(str::to_string),
            title: record
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_string),
        });
    }
    records
}

/// Counts of open issues each dedup turn read, oldest first.
pub fn read_dedup_reads(run_dir: &Path) -> Vec<i64> {
    let Ok(text) = std::fs::read_to_string(run_dir.join("dedup-reads.jsonl")) else {
        return Vec::new();
    };
    let mut counts = Vec::new();
    for line in text.split('\n') {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let Some(count) = parsed.get("count").and_then(Value::as_i64) else {
            continue;
        };
        if count >= 0 {
            counts.push(count);
        }
    }
    counts
}

/// The verification stub: answers every deduplication call deterministically.
pub struct StubDedup {
    path: PathBuf,
}

impl StubDedup {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }
}

impl DedupRunner for StubDedup {
    fn run(&self, request: &DedupRequest, run_dir: &Path) -> Result<String, String> {
        let text = std::fs::read_to_string(&self.path)
            .map_err(|error| format!("the deduplication agent stub could not be read: {error}"))?;
        let document: Value = serde_json::from_str(&text)
            .map_err(|error| format!("the deduplication agent stub is not an object: {error}"))?;
        let Some(document) = document.as_object() else {
            return Err("the deduplication agent stub is not an object".to_string());
        };
        if let Some(error) = document.get("error").and_then(Value::as_str) {
            return Err(error.to_string());
        }
        let decisions = document
            .get("decisions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut records: Vec<Value> = Vec::new();
        for entry in decisions {
            let Some(decision) = entry.as_object() else {
                continue;
            };
            if decision.get("fingerprint").and_then(Value::as_str) == Some("*") {
                for candidate in &request.candidates {
                    let mut expanded = decision.clone();
                    expanded.insert("fingerprint".to_string(), json!(candidate.fingerprint));
                    records.push(Value::Object(expanded));
                }
                continue;
            }
            records.push(entry);
        }
        std::fs::create_dir_all(run_dir)
            .map_err(|error| format!("the dedup run directory: {error}"))?;
        let reads = match document.get("reads") {
            Some(Value::Number(number)) => match number.as_i64() {
                Some(count) if count >= 0 => count,
                _ => request.candidates.len() as i64,
            },
            _ => request.candidates.len() as i64,
        };
        append_line(
            &run_dir.join("dedup-reads.jsonl"),
            &format!("{}\n", crate::jsjson::stringify(&json!({"count": reads}))),
        )
        .map_err(|error| format!("the dedup reads: {error}"))?;
        if !records.is_empty() {
            let lines: Vec<String> = records.iter().map(crate::jsjson::stringify).collect();
            append_line(
                &run_dir.join("dedup-records.jsonl"),
                &format!("{}\n", lines.join("\n")),
            )
            .map_err(|error| format!("the dedup records: {error}"))?;
        }
        Ok(String::new())
    }
}

fn append_line(path: &Path, text: &str) -> io::Result<()> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    file.write_all(text.as_bytes())
}

/// The production deduplication turn: one `omp acp` peer per enabled
/// OpenCode Go subscription, given the shipped watchdog-dedup prompt and the
/// run directory its MCP tools append to. A key the model provider rejects
/// rotates to the next subscription; the peer never inherits
/// `PI_CODING_AGENT_DIR`.
pub struct AcpDedup {
    pub command: String,
    pub repo_dir: PathBuf,
    pub environment: HashMap<String, String>,
    pub timeout_ms: u64,
    /// The dashboard STATE_DIR holding `providers/`; `None` uses the base
    /// environment as one attempt.
    pub provider_state_dir: Option<PathBuf>,
}

const WATCHDOG_DEDUP_PROMPT: &str = include_str!("../../../../prompts/watchdog-dedup.md");

/// The default peer deadline: four minutes.
pub const DEDUP_PEER_TIMEOUT_MS: u64 = 240_000;

/// A provider message that means the key was rejected.
fn credential_rejection(text: &str) -> bool {
    static PATTERN: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)invalid credential|invalid api key|unauthorized|\b401\b")
            .expect("a credential regex")
    });
    PATTERN.is_match(text)
}

impl AcpDedup {
    /// The environment one attempt runs with. A generated agent directory is
    /// always this turn's own; nothing inherited is kept.
    fn attempt_environment(&self, base: &HashMap<String, String>) -> HashMap<String, String> {
        let mut environment = base.clone();
        environment.remove("PI_CODING_AGENT_DIR");
        environment
    }

    fn run_with_environment(
        &self,
        environment: HashMap<String, String>,
        request: &DedupRequest,
        run_dir: &Path,
    ) -> Result<String, String> {
        let candidates = request.to_json()["candidates"].clone();
        let prompt = WATCHDOG_DEDUP_PROMPT
            .replace("{{repository}}", &request.repository)
            .replace(
                "{{candidates}}",
                &serde_json::to_string_pretty(&candidates).unwrap_or_default(),
            )
            .replace("{{filingRoom}}", &request.filing_room.to_string());
        let mut environment = environment;
        environment.insert(
            "DEVBOARD_DEDUP_RUN_DIR".to_string(),
            run_dir.to_string_lossy().into_owned(),
        );
        let mcp_servers = crate::acp::session_mcp_servers(&environment);
        let options = crate::acp::AcpConnectionOptions::new(
            self.command.clone(),
            self.repo_dir.to_string_lossy().into_owned(),
        )
        .with_env(environment)
        .with_mcp_servers(mcp_servers)
        .with_permission_policy(crate::acp::PermissionPolicy::Deny);
        let timeout_ms = self.timeout_ms;
        let prompt_for_peer = prompt.clone();
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|error| error.to_string())?;
            runtime.block_on(async move {
                let (connection, mut events) =
                    crate::acp::AcpConnection::connect(options)
                        .await
                        .map_err(|error| error.to_string())?;
                let future = connection.run(&prompt_for_peer);
                tokio::pin!(future);
                let deadline =
                    tokio::time::Instant::now() + Duration::from_millis(timeout_ms.max(1));
                let mut text = String::new();
                let mut stderr = String::new();
                loop {
                    tokio::select! {
                        result = &mut future => {
                            connection.close();
                            return match result {
                                Ok(_) => Ok(text),
                                Err(error) => {
                                    let detail = stderr
                                        .split('\n')
                                        .map(str::trim)
                                        .find(|line| !line.is_empty());
                                    Err(match detail {
                                        Some(detail) => format!("{error} ({detail})"),
                                        None => error.to_string(),
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
                                        let boundary = (0..=cut)
                                            .rev()
                                            .find(|index| stderr.is_char_boundary(*index))
                                            .unwrap_or(0);
                                        stderr = stderr[boundary..].to_string();
                                    }
                                }
                                Some(crate::acp::AcpEvent::Question(_)) => {
                                    connection.close();
                                    return Err("the dedup peer asked a question; refusing".to_string());
                                }
                                Some(_) => {}
                                None => {}
                            }
                        }
                        _ = tokio::time::sleep_until(deadline) => {
                            connection.close();
                            return Err(format!(
                                "the dedup peer timed out after {timeout_ms}ms"
                            ));
                        }
                    }
                }
            })
        })
        .join()
        .map_err(|_| "the dedup peer panicked".to_string())?
    }
}

/// Runs one attempt per binding in order. A rejected credential rotates to
/// the next binding; any other failure, or the last binding, ends the turn.
pub fn rotate_dedup_attempts<F>(
    peers: &[crate::providers::PeerBinding],
    mut attempt: F,
) -> Result<String, String>
where
    F: FnMut(&crate::providers::PeerBinding) -> Result<String, String>,
{
    let mut last: Option<String> = None;
    for (index, binding) in peers.iter().enumerate() {
        match attempt(binding) {
            Ok(text) => return Ok(text),
            Err(error) => {
                let rejected = credential_rejection(&error);
                let last_peer = index == peers.len() - 1;
                last = Some(error);
                if !rejected || last_peer {
                    break;
                }
            }
        }
    }
    Err(last.unwrap_or_else(|| "the dedup peer returned no answer".to_string()))
}

impl DedupRunner for AcpDedup {
    fn run(&self, request: &DedupRequest, run_dir: &Path) -> Result<String, String> {
        std::fs::create_dir_all(run_dir)
            .map_err(|error| format!("the dedup run directory: {error}"))?;
        let peers = match self.provider_state_dir.as_deref() {
            Some(state_dir) => {
                crate::workers::mcp_optimizer::open_code_peers(state_dir, &self.environment)?
            }
            None => Vec::new(),
        };
        if peers.is_empty() {
            let environment = self.attempt_environment(&self.environment);
            return self.run_with_environment(environment, request, run_dir);
        }
        rotate_dedup_attempts(&peers, |binding| {
            let environment: HashMap<String, String> = binding
                .env
                .iter()
                .filter_map(|(key, value)| value.clone().map(|value| (key.clone(), value)))
                .collect();
            self.run_with_environment(environment, request, run_dir)
        })
    }
}

/// The gate refuses to file when no deduplication turn can run.
///
/// The TypeScript peer turn drives a generated bun MCP server, which this
/// build never spawns; a cycle therefore fails closed and keeps every
/// candidate pending unless a `DedupRunner` (or the verification stub) is
/// injected. The gate, its records, its reads, and its file/duplicate/fail
/// decisions are otherwise the same.
pub struct UnavailableDedup {
    pub reason: String,
}

impl DedupRunner for UnavailableDedup {
    fn run(&self, _request: &DedupRequest, _run_dir: &Path) -> Result<String, String> {
        Err(self.reason.clone())
    }
}

// ---------------------------------------------------------------------------
// The cycle
// ---------------------------------------------------------------------------

/// One cycle's inputs.
#[derive(Clone, Debug)]
pub struct CycleOptions {
    pub root: PathBuf,
    pub now_ms: i64,
    pub state_dir: Option<PathBuf>,
    pub dry_run: bool,
    /// The evidence window; a running worker passes its cadence interval.
    pub window_ms: Option<u64>,
    pub settings: Option<WatchdogSettings>,
    /// The dashboard STATE_DIR whose `providers/` holds the dedup key.
    pub provider_state_dir: Option<PathBuf>,
    pub environment: HashMap<String, String>,
}

impl CycleOptions {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            now_ms: epoch_ms(),
            state_dir: None,
            dry_run: false,
            window_ms: None,
            settings: None,
            provider_state_dir: None,
            environment: std::env::vars().collect(),
        }
    }
}

/// The cycle's injectable collaborators.
pub struct CycleDeps {
    pub discover: Arc<dyn Fn(&Path) -> Vec<Instance> + Send + Sync>,
    pub collect: Arc<dyn Fn(&Path, &[Instance], Window) -> Collection + Send + Sync>,
    pub gh: GhRun,
    pub delivery: Option<Arc<dyn WatchdogDelivery>>,
    pub dedup: Option<Arc<dyn DedupRunner>>,
}

impl CycleDeps {
    /// The production wiring: `/proc` discovery, journal collection, and `gh`.
    pub fn production() -> Self {
        Self {
            discover: Arc::new(|root: &Path| discover_instances_for(root)),
            collect: Arc::new(|root: &Path, instances: &[Instance], window: Window| {
                let self_pids = HashSet::from([std::process::id()]);
                collect_evidence(root, instances, window, &self_pids, None, None)
            }),
            gh: default_gh(),
            delivery: None,
            dedup: None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Report {
    pub value: Value,
}

impl Report {
    pub fn action(&self) -> &str {
        self.value
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("none")
    }

    pub fn reason(&self) -> Option<&str> {
        self.value.get("reason").and_then(Value::as_str)
    }

    pub fn pending(&self) -> i64 {
        self.value
            .get("pending")
            .and_then(Value::as_i64)
            .unwrap_or(0)
    }

    pub fn findings(&self) -> Vec<Value> {
        self.value
            .get("findings")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    }

    pub fn issues(&self) -> Vec<Value> {
        self.value
            .get("issues")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    }
}

#[derive(Clone, Debug)]
pub struct CycleResult {
    pub report: Report,
    pub exit_code: i32,
    pub run_dir: Option<PathBuf>,
}

fn stamp(now_ms: i64) -> String {
    iso_from_ms(now_ms).replace([':', '.'], "-")
}

fn diagnostic_line(error: &str) -> String {
    error
        .split('\n')
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("no diagnostic")
        .to_string()
}

fn is_filed(entry: Option<&LedgerEntry>) -> bool {
    entry.is_some_and(|entry| entry.disposition.starts_with("filed:"))
}

/// The JSON one cleanup report renders, for the manual CLI.
pub fn cleanup_report_json(report: &CleanupReport) -> Value {
    cleanup_json(report)
}

/// Stops, disables, and removes the legacy systemd unit and timer.
///
/// The unit directory is the user systemd directory, or
/// `DEVBOARD_SYSTEMD_USER_DIR` when a fixture supplies one. Nothing inside a
/// repository is read or written.
pub fn uninstall_legacy_units() {
    const UNITS: [&str; 2] = ["devboard-watchdog.timer", "devboard-watchdog.service"];
    let directory = std::env::var_os("DEVBOARD_SYSTEMD_USER_DIR")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("XDG_CONFIG_HOME")
                .map(std::path::PathBuf::from)
                .or_else(|| {
                    std::env::var_os("HOME")
                        .map(|home| std::path::PathBuf::from(home).join(".config"))
                })
                .map(|base| base.join("systemd").join("user"))
        });
    for unit in UNITS {
        for (verb, args) in [
            ("stop", ["--user", "stop", unit]),
            ("disable", ["--user", "disable", unit]),
        ] {
            let status = std::process::Command::new("systemctl")
                .args(args)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
            if status.map(|status| status.success()).unwrap_or(false) {
                println!("watchdog: {verb} {unit}");
            }
        }
        if let Some(directory) = &directory {
            let path = directory.join(unit);
            if path.exists() {
                match std::fs::remove_file(&path) {
                    Ok(()) => println!("watchdog: removed {}", path.display()),
                    Err(error) => eprintln!("watchdog: cannot remove {}: {error}", path.display()),
                }
            }
        }
    }
    let _ = std::process::Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    println!("watchdog: legacy unit and timer removed");
}

fn cleanup_json(report: &CleanupReport) -> Value {
    let candidate_json = |candidate: &CleanupCandidate| {
        json!({
            "path": candidate.path.to_string_lossy(),
            "bytes": candidate.bytes,
            "kind": candidate.kind.as_str(),
        })
    };
    let roots: Vec<Value> = report
        .roots
        .iter()
        .map(|root| {
            json!({
                "stateDir": root.state_dir.to_string_lossy(),
                "source": root.source.as_str(),
                "candidates": root.candidates.iter().map(candidate_json).collect::<Vec<Value>>(),
                "removed": root.removed.iter().map(candidate_json).collect::<Vec<Value>>(),
                "bytes": root.bytes,
                "files": root.files,
                "directories": root.directories,
                "errors": root.errors,
            })
        })
        .collect();
    json!({
        "now": report.now,
        "cutoff": report.cutoff,
        "dryRun": report.dry_run,
        "roots": roots,
    })
}

fn instance_json(instance: &Instance) -> Value {
    let mut value = json!({
        "pid": instance.pid,
        "port": instance.port,
        "repoDir": instance.repo_dir,
        "harness": instance.harness,
        "instrumented": instance.instrumented,
        "journal": instance.journal,
    });
    if let Some(legacy) = &instance.legacy_log {
        value["legacyLog"] = json!(legacy);
    }
    value
}

fn finding_json(finding: &Finding) -> Value {
    let instances: Vec<Value> = finding
        .instances
        .iter()
        .map(|instance| {
            json!({
                "repoDir": instance.repo_dir,
                "port": instance.port,
                "pid": instance.pid,
                "journal": instance.journal,
            })
        })
        .collect();
    json!({
        "category": finding.category,
        "ts": finding.ts,
        "quote": finding.quote,
        "fingerprint": finding.fingerprint,
        "instances": instances,
    })
}

fn issue_input(
    fingerprint: &str,
    entry: &LedgerEntry,
    window: Window,
    report_path: &str,
) -> IssueInput {
    IssueInput {
        category: entry.category.clone(),
        fingerprint: fingerprint.to_string(),
        line: entry.line.clone(),
        first_seen: entry.first_seen.clone(),
        last_seen: entry.last_seen.clone(),
        count: entry.count,
        window,
        instances: entry.instances.clone(),
        report_path: report_path.to_string(),
    }
}

/// Runs one watchdog cycle. The caller owns the singleton lock.
pub fn run_cycle(options: &CycleOptions, deps: &CycleDeps) -> anyhow::Result<CycleResult> {
    let root = absolute(&options.root);
    let harness = root.join(".devboard");
    let now = options.now_ms;
    let window_ms = options.window_ms.unwrap_or(WINDOW_MS).max(60_000);
    let window = Window {
        start_ms: now - window_ms as i64,
        end_ms: now,
    };
    // A start in the window's final five minutes is not a stall yet, and the
    // next window begins at this one's end, so collection reads one stall
    // interval further back.
    let stall_lookback = Window {
        start_ms: window.start_ms - STALL_MS,
        end_ms: now,
    };
    let state_dir = options
        .state_dir
        .clone()
        .unwrap_or_else(|| harness.join(".tmp").join(WATCHDOG_DIRECTORY));
    let settings = options
        .settings
        .clone()
        .unwrap_or_else(|| read_watchdog_settings(&state_dir));
    let run_dir = runs_directory(&state_dir).join(stamp(now));
    let report_path = run_dir.join("report.json").to_string_lossy().into_owned();
    let dry_run = options.dry_run;
    if !dry_run {
        std::fs::create_dir_all(&run_dir)?;
    }
    let coordinator_log = if dry_run {
        None
    } else {
        Some(run_dir.join("coordinator.log"))
    };
    let log = |line: &str| {
        if let Some(path) = &coordinator_log {
            let stamped = format!("{} {line}\n", now_iso());
            let _ = append_line(path, &stamped);
        }
        eprintln!("watchdog: {line}");
    };

    let mut ledger = load_ledger(&state_dir);
    let instances = (deps.discover)(&root);
    log(&format!("discovered {} instance(s)", instances.len()));

    let covered = covered_state_dirs(&root, &instances);
    if !dry_run {
        for entry in &covered {
            let removed = prune_journals(&entry.state_dir, now, stall_lookback.start_ms);
            if !removed.is_empty() {
                log(&format!(
                    "pruned {} old journal file(s) in {}",
                    removed.len(),
                    entry.state_dir.display()
                ));
            }
        }
    }

    let cleanup = run_cleanup(
        &root,
        now,
        dry_run,
        &instances,
        Some(&covered),
        Some(&run_dir),
    );
    for entry in &cleanup.roots {
        log(&format!(
            "cleanup {}: {} {} file(s), {} directory/directories, {} byte(s){}",
            entry.state_dir.display(),
            if dry_run { "would remove" } else { "removed" },
            entry.files,
            entry.directories,
            entry.bytes,
            if entry.errors.is_empty() {
                String::new()
            } else {
                format!(", {} error(s)", entry.errors.len())
            }
        ));
        for error in &entry.errors {
            log(&format!("cleanup {}: {error}", entry.state_dir.display()));
        }
    }

    let collection = (deps.collect)(&root, &instances, stall_lookback);
    let findings = analyze_evidence(&collection.events, window, stall_lookback);
    log(&format!(
        "collected {} event(s), {} finding(s), {} malformed, {} unattributed",
        collection.events.len(),
        findings.len(),
        collection.malformed,
        collection.unattributed
    ));
    record_findings(&mut ledger, &findings, now);

    let pending_before = ledger.pending_filing.len() as i64;

    if dry_run {
        let settled = findings
            .iter()
            .all(|finding| is_filed(ledger.get(&finding.fingerprint)));
        let (action, reason) = if findings.is_empty() && ledger.pending_filing.is_empty() {
            ("none", "no finding in the window".to_string())
        } else if settled && ledger.pending_filing.is_empty() {
            (
                "duplicate",
                "every finding already has an issue".to_string(),
            )
        } else {
            (
                "none",
                format!(
                    "dry run: {} finding(s) and {} pending filing(s) not attempted",
                    findings.len(),
                    ledger.pending_filing.len()
                ),
            )
        };
        let value = report_value(&ReportParts {
            now,
            window,
            window_ms,
            instances: &instances,
            findings: &findings,
            action,
            reason: Some(reason),
            issues: Vec::new(),
            unowned: Vec::new(),
            pending: pending_before,
            report_path: &report_path,
            malformed: collection.malformed,
            unattributed: collection.unattributed,
            cleanup: &cleanup,
            requested: 0,
            open_issues_read: 0,
            decisions: Vec::new(),
            suppressed: Vec::new(),
        });
        return Ok(CycleResult {
            report: Report { value },
            exit_code: 0,
            run_dir: None,
        });
    }

    let mut delivery = deps.delivery.clone();
    let mut delivery_failure: Option<String> = None;
    let ensure_delivery = |delivery: &mut Option<Arc<dyn WatchdogDelivery>>,
                           failure: &mut Option<String>|
     -> Option<Arc<dyn WatchdogDelivery>> {
        if delivery.is_some() {
            return delivery.clone();
        }
        if failure.is_some() {
            return None;
        }
        match create_watchdog_delivery(&root, deps.gh.clone()) {
            Ok(created) => {
                *delivery = Some(created.clone());
                Some(created)
            }
            Err(error) => {
                *failure = Some(diagnostic_line(&error));
                None
            }
        }
    };

    let mut queue: Vec<String> = ledger
        .pending_filing
        .iter()
        .filter(|fingerprint| !is_filed(ledger.get(fingerprint)))
        .cloned()
        .collect();
    for finding in &findings {
        if is_filed(ledger.get(&finding.fingerprint)) {
            continue;
        }
        if !ledger
            .pending_filing
            .iter()
            .any(|pending| pending == &finding.fingerprint)
        {
            queue.push(finding.fingerprint.clone());
        }
    }
    if !queue.is_empty() {
        ensure_delivery(&mut delivery, &mut delivery_failure);
    }

    let mut failure: Option<String> = None;
    let mut suppressed: Vec<Value> = Vec::new();
    let mut candidates: Vec<String> = Vec::new();
    for fingerprint in &queue {
        let entry_option = ledger.get(fingerprint).cloned();
        let Some(entry) = entry_option else {
            ledger.remove_pending(fingerprint);
            continue;
        };
        if entry.disposition.starts_with("duplicate:") {
            let matched = entry
                .duplicate_of
                .clone()
                .unwrap_or_else(|| entry.disposition["duplicate:".len()..].to_string());
            let open = match &delivery {
                None => true,
                Some(active) => matches!(active.state(&matched), Some(IssueState::Open)),
            };
            if open {
                suppressed.push(json!({"fingerprint": fingerprint, "issue": matched}));
                ledger.remove_pending(fingerprint);
                continue;
            }
        }
        candidates.push(fingerprint.clone());
    }

    // Caps: a cap counts new issues per rolling hour and open issues from the
    // last successful projection; an unavailable projection leaves no room.
    let caps_active = settings.max_per_hour.is_some() || settings.max_pending.is_some();
    let mut caps_reason: Option<String> = None;
    let filing_room = if !caps_active {
        i64::MAX
    } else {
        let hour_start = now - 60 * 60 * 1000;
        let mut filed_this_hour = 0_i64;
        for (_, entry) in &ledger.findings {
            if !entry.disposition.starts_with("filed:") {
                continue;
            }
            let filed_at = entry.filed_at.as_deref().and_then(parse_iso_ms);
            if filed_at.is_some_and(|filed| filed > hour_start) {
                filed_this_hour += 1;
            }
        }
        match read_projection(&state_dir) {
            Some(projection) if projection.state == ProjectionState::Ok => {
                let open = projection
                    .issues
                    .iter()
                    .filter(|issue| {
                        matches!(
                            issue.state,
                            ProjectionIssueState::Pending | ProjectionIssueState::Unreadable
                        )
                    })
                    .count() as i64;
                let hourly_room = settings
                    .max_per_hour
                    .map(|cap| (cap - filed_this_hour).max(0))
                    .unwrap_or(i64::MAX);
                let open_room = settings
                    .max_pending
                    .map(|cap| (cap - open).max(0))
                    .unwrap_or(i64::MAX);
                hourly_room.min(open_room)
            }
            _ => {
                caps_reason = Some(
                    "a filing cap is set and the GitHub projection is not ok; nothing new was filed"
                        .to_string(),
                );
                0
            }
        }
    };

    let mut decisions: Vec<Value> = Vec::new();
    let mut open_issues_read = 0_i64;
    let mut unique_candidates: Vec<String> = Vec::new();
    let mut gate_blocked = false;
    let mut report_issues: Vec<Value> = Vec::new();
    if !candidates.is_empty() {
        if delivery.is_none() {
            let reason = delivery_failure
                .clone()
                .unwrap_or_else(|| "the watchdog delivery is unavailable".to_string());
            if failure.is_none() {
                failure = Some(reason.clone());
            }
            gate_blocked = true;
            for fingerprint in &candidates {
                mark_pending(&mut ledger, fingerprint);
                decisions.push(json!({
                    "fingerprint": fingerprint,
                    "category": ledger.get(fingerprint).map(|entry| entry.category.clone()).unwrap_or_else(|| "unknown".to_string()),
                    "decision": "failed",
                    "reason": reason,
                }));
            }
            log(&format!("deduplication not attempted: {reason}"));
        } else if let Some(active) = delivery.clone() {
            let dedup_window = DedupWindow {
                start: window.start_iso(),
                end: window.end_iso(),
            };
            let request = DedupRequest {
                repository: active.repository().to_string(),
                window: dedup_window.clone(),
                filing_room: if filing_room == i64::MAX {
                    candidates.len() as i64
                } else {
                    filing_room.max(0)
                },
                candidates: candidates
                    .iter()
                    .filter_map(|fingerprint| {
                        let entry = ledger.get(fingerprint)?;
                        Some(DedupCandidate {
                            fingerprint: fingerprint.clone(),
                            category: entry.category.clone(),
                            line: entry.line.clone(),
                            first_seen: entry.first_seen.clone(),
                            last_seen: entry.last_seen.clone(),
                            count: entry.count,
                            instances: entry.instances.clone(),
                            window: dedup_window.clone(),
                        })
                    })
                    .collect(),
            };
            let dedup_run_dir = run_dir.join("dedup");
            let _ = std::fs::create_dir_all(&dedup_run_dir);
            let stub_path = options
                .environment
                .get(DEDUP_STUB_ENV)
                .filter(|value| !value.is_empty())
                .cloned();
            let runner: Arc<dyn DedupRunner> = match &deps.dedup {
                Some(runner) => runner.clone(),
                None => match stub_path {
                    Some(path) => Arc::new(StubDedup::new(path)),
                    None => {
                        let command = options
                            .environment
                            .get("AGENT_COMMAND")
                            .filter(|value| !value.is_empty())
                            .cloned()
                            .unwrap_or_else(|| "omp acp".to_string());
                        Arc::new(AcpDedup {
                            command,
                            repo_dir: options.root.clone(),
                            environment: options.environment.clone(),
                            timeout_ms: DEDUP_PEER_TIMEOUT_MS,
                            provider_state_dir: options.provider_state_dir.clone(),
                        })
                    }
                },
            };
            match runner.run(&request, &dedup_run_dir) {
                Err(error) => {
                    let reason = diagnostic_line(&error);
                    if failure.is_none() {
                        failure = Some(format!("the deduplication agent failed: {reason}"));
                    }
                    gate_blocked = true;
                    for fingerprint in &candidates {
                        mark_pending(&mut ledger, fingerprint);
                        decisions.push(json!({
                            "fingerprint": fingerprint,
                            "category": ledger.get(fingerprint).map(|entry| entry.category.clone()).unwrap_or_else(|| "unknown".to_string()),
                            "decision": "failed",
                            "reason": reason,
                        }));
                    }
                    log(&format!("deduplication failed: {reason}"));
                }
                Ok(_) => {
                    let records = read_dedup_records(&dedup_run_dir);
                    let mut by_fingerprint: HashMap<String, DedupRecord> = HashMap::new();
                    for record in records {
                        by_fingerprint.insert(record.fingerprint.clone(), record);
                    }
                    let reads = read_dedup_reads(&dedup_run_dir);
                    open_issues_read = reads.last().copied().unwrap_or(0);
                    if reads.is_empty() {
                        let reason = "the deduplication turn read no open issue".to_string();
                        if failure.is_none() {
                            failure = Some(reason.clone());
                        }
                        gate_blocked = true;
                        for fingerprint in &candidates {
                            mark_pending(&mut ledger, fingerprint);
                            decisions.push(json!({
                                "fingerprint": fingerprint,
                                "category": ledger.get(fingerprint).map(|entry| entry.category.clone()).unwrap_or_else(|| "unknown".to_string()),
                                "decision": "failed",
                                "reason": reason,
                            }));
                        }
                        log(&format!("deduplication failed: {reason}"));
                    } else {
                        for fingerprint in &candidates {
                            let Some(entry) = ledger.get(fingerprint).cloned() else {
                                continue;
                            };
                            let Some(record) = by_fingerprint.get(fingerprint) else {
                                let reason = "the deduplication turn recorded no decision";
                                if filing_room > 0 && failure.is_none() {
                                    failure = Some(reason.to_string());
                                }
                                mark_pending(&mut ledger, fingerprint);
                                decisions.push(json!({
                                    "fingerprint": fingerprint,
                                    "category": entry.category,
                                    "decision": "failed",
                                    "reason": reason,
                                }));
                                continue;
                            };
                            if record.action == "filed" {
                                if let Some(url) = &record.url {
                                    unique_candidates.push(fingerprint.clone());
                                    mark_filed(&mut ledger, fingerprint, url, now);
                                    let _ = save_ledger(&state_dir, &ledger);
                                    report_issues.push(json!({
                                        "url": url,
                                        "category": entry.category,
                                        "fingerprint": fingerprint,
                                        "line": entry.line,
                                    }));
                                    decisions.push(json!({
                                        "fingerprint": fingerprint,
                                        "category": entry.category,
                                        "decision": "unique",
                                    }));
                                    log(&format!(
                                        "filed {url} for {}: {}",
                                        entry.category, entry.line
                                    ));
                                    continue;
                                }
                            }
                            if record.action == "duplicate" {
                                match &record.issue {
                                    Some(issue) => {
                                        mark_duplicate(&mut ledger, fingerprint, issue, now)
                                    }
                                    None => ledger.remove_pending(fingerprint),
                                }
                                let mut decision = json!({
                                    "fingerprint": fingerprint,
                                    "category": entry.category,
                                    "decision": "duplicate",
                                });
                                if let Some(issue) = &record.issue {
                                    decision["issue"] = json!(issue);
                                }
                                if let Some(representative) = &record.representative {
                                    decision["representative"] = json!(representative);
                                }
                                decisions.push(decision);
                                continue;
                            }
                            let reason = "the deduplication turn recorded no filed issue";
                            if filing_room > 0 && failure.is_none() {
                                failure = Some(reason.to_string());
                            }
                            mark_pending(&mut ledger, fingerprint);
                            decisions.push(json!({
                                "fingerprint": fingerprint,
                                "category": entry.category,
                                "decision": "failed",
                                "reason": reason,
                            }));
                        }
                        let count_of = |wanted: &str| -> usize {
                            decisions
                                .iter()
                                .filter(|decision| {
                                    decision.get("decision").and_then(Value::as_str) == Some(wanted)
                                })
                                .count()
                        };
                        log(&format!(
                            "deduplication: {} candidate(s), {} unique, {} duplicate, {} failed",
                            candidates.len(),
                            unique_candidates.len(),
                            count_of("duplicate"),
                            count_of("failed")
                        ));
                    }
                }
            }
        }
    }

    let mut unowned: Vec<Value> = Vec::new();
    let mut commented = 0_usize;
    let filed_this_cycle: HashSet<String> = report_issues
        .iter()
        .filter_map(|issue| {
            issue
                .get("fingerprint")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect();
    let commentable: Vec<&Finding> = if gate_blocked {
        Vec::new()
    } else {
        findings.iter().collect()
    };
    for finding in commentable {
        let Some(entry) = ledger.get(&finding.fingerprint).cloned() else {
            continue;
        };
        let Some(url) = entry.url.clone() else {
            continue;
        };
        if filed_this_cycle.contains(&finding.fingerprint) {
            continue;
        }
        let baseline = entry
            .last_comment_at
            .as_deref()
            .or(entry.filed_at.as_deref())
            .and_then(parse_iso_ms);
        let Some(baseline) = baseline else {
            continue;
        };
        if now - baseline < COMMENT_INTERVAL_MS {
            continue;
        }
        let Some(active) = ensure_delivery(&mut delivery, &mut delivery_failure) else {
            let reason = delivery_failure
                .clone()
                .unwrap_or_else(|| "the watchdog delivery is unavailable".to_string());
            if failure.is_none() {
                failure = Some(reason.clone());
            }
            log(&format!("comment on {url} failed: {reason}"));
            continue;
        };
        if !active.owns(&url) {
            unowned.push(json!({
                "url": url,
                "category": entry.category,
                "fingerprint": finding.fingerprint,
            }));
            log(&format!(
                "comment on {url} skipped: the configured forge does not serve that issue"
            ));
            continue;
        }
        let input = issue_input(&finding.fingerprint, &entry, window, &report_path);
        match active.comment(&url, &input) {
            CommentResult::Ok => {
                mark_commented(&mut ledger, &finding.fingerprint, now);
                let _ = save_ledger(&state_dir, &ledger);
                commented += 1;
                log(&format!("commented on {url}"));
            }
            CommentResult::Failed { reason } => {
                if failure.is_none() {
                    failure = Some(reason.clone());
                }
                log(&format!("comment on {url} failed: {reason}"));
            }
        }
    }

    let (action, reason) = if let Some(failure) = &failure {
        ("failed", failure.clone())
    } else if !report_issues.is_empty() {
        ("filed", format!("filed {} issue(s)", report_issues.len()))
    } else if commented > 0 {
        ("commented", format!("commented on {commented} issue(s)"))
    } else if caps_active && !ledger.pending_filing.is_empty() {
        (
            "capped",
            caps_reason.clone().unwrap_or_else(|| {
                format!(
                    "filing cap reached; {} finding(s) stay pending",
                    ledger.pending_filing.len()
                )
            }),
        )
    } else if !unowned.is_empty() {
        (
            "skipped",
            format!(
                "{} ledger issue URL(s) belong to another forge; no comment was made",
                unowned.len()
            ),
        )
    } else if !candidates.is_empty() || !suppressed.is_empty() {
        (
            "duplicate",
            "every candidate duplicates an open issue".to_string(),
        )
    } else if !findings.is_empty() || !ledger.pending_filing.is_empty() {
        (
            "duplicate",
            "every finding already has an issue".to_string(),
        )
    } else {
        ("none", "no finding in the window".to_string())
    };
    let pending = ledger.pending_filing.len() as i64;

    let value = report_value(&ReportParts {
        now,
        window,
        window_ms,
        instances: &instances,
        findings: &findings,
        action,
        reason: Some(reason.clone()),
        issues: report_issues.clone(),
        unowned: unowned.clone(),
        pending,
        report_path: &report_path,
        malformed: collection.malformed,
        unattributed: collection.unattributed,
        cleanup: &cleanup,
        requested: candidates.len() as i64,
        open_issues_read,
        decisions: decisions.clone(),
        suppressed: suppressed.clone(),
    });

    let _ = save_ledger(&state_dir, &ledger);
    let mut text = serde_json::to_string_pretty(&value).unwrap_or_else(|_| "null".to_string());
    text.push('\n');
    std::fs::write(&report_path, &text)?;
    std::fs::write(latest_path(&state_dir), &text)?;
    let report = Report { value };
    std::fs::write(run_dir.join("report.md"), render_markdown(&report))?;
    log(&format!("cycle {action}: {reason}"));

    Ok(CycleResult {
        report,
        exit_code: if action == "failed" { 1 } else { 0 },
        run_dir: Some(run_dir),
    })
}

struct ReportParts<'a> {
    now: i64,
    window: Window,
    window_ms: u64,
    instances: &'a [Instance],
    findings: &'a [Finding],
    action: &'a str,
    reason: Option<String>,
    issues: Vec<Value>,
    unowned: Vec<Value>,
    pending: i64,
    report_path: &'a str,
    malformed: usize,
    unattributed: usize,
    cleanup: &'a CleanupReport,
    requested: i64,
    open_issues_read: i64,
    decisions: Vec<Value>,
    suppressed: Vec<Value>,
}

fn report_value(parts: &ReportParts<'_>) -> Value {
    let minutes = if parts.window_ms % 60_000 == 0 {
        json!(parts.window_ms / 60_000)
    } else {
        json!(parts.window_ms as f64 / 60_000.0)
    };
    let mut value = json!({
        "cycle": iso_from_ms(parts.now),
        "window": {
            "start": parts.window.start_iso(),
            "end": parts.window.end_iso(),
            "minutes": minutes,
        },
        "instances": parts.instances.iter().map(instance_json).collect::<Vec<Value>>(),
        "findings": parts.findings.iter().map(finding_json).collect::<Vec<Value>>(),
        "action": parts.action,
        "issues": parts.issues,
        "unowned": parts.unowned,
        "pending": parts.pending,
        "reportPath": parts.report_path,
    });
    if let Some(reason) = &parts.reason {
        value["reason"] = json!(reason);
    }
    value["malformed"] = json!(parts.malformed);
    value["unattributed"] = json!(parts.unattributed);
    value["cleanup"] = cleanup_json(parts.cleanup);
    value["deduplication"] = json!({
        "requested": parts.requested,
        "openIssuesRead": parts.open_issues_read,
        "decisions": parts.decisions,
        "suppressed": parts.suppressed,
    });
    value
}

fn render_markdown(report: &Report) -> String {
    let value = &report.value;
    let window = &value["window"];
    let action = report.action();
    let reason = report.reason().unwrap_or("none");
    let findings = report.findings();
    let pending = report.pending();
    let instances = value["instances"].as_array().cloned().unwrap_or_default();
    let issues = report.issues();
    let unowned = value["unowned"].as_array().cloned().unwrap_or_default();
    let mut lines = vec![
        format!("# Watchdog cycle {}", value["cycle"].as_str().unwrap_or("")),
        String::new(),
        format!(
            "- Window: {} .. {} ({} minutes)",
            window["start"].as_str().unwrap_or(""),
            window["end"].as_str().unwrap_or(""),
            window["minutes"]
        ),
        format!("- Action: {action}"),
        format!("- Reason: {reason}"),
        format!("- Findings: {}", findings.len()),
        format!("- Pending filings: {pending}"),
        String::new(),
        "## Instances".to_string(),
        String::new(),
    ];
    if instances.is_empty() {
        lines.push("No dashboard was running.".to_string());
    } else {
        for instance in &instances {
            lines.push(format!(
                "- port {}: {} (pid {}, {})",
                instance["port"],
                instance["repoDir"].as_str().unwrap_or(""),
                instance["pid"],
                if instance["instrumented"].as_bool() == Some(true) {
                    "instrumented"
                } else {
                    "uninstrumented"
                }
            ));
        }
    }
    lines.push(String::new());
    lines.push("## Findings".to_string());
    lines.push(String::new());
    if findings.is_empty() {
        lines.push("None.".to_string());
    } else {
        for finding in &findings {
            lines.push(format!(
                "- {} at {}: {}",
                finding["category"].as_str().unwrap_or(""),
                finding["ts"].as_str().unwrap_or(""),
                finding["quote"].as_str().unwrap_or("")
            ));
        }
    }
    lines.push(String::new());
    lines.push("## Issues".to_string());
    lines.push(String::new());
    if issues.is_empty() {
        lines.push("None.".to_string());
    } else {
        for issue in &issues {
            lines.push(format!(
                "- {} ({})",
                issue["url"].as_str().unwrap_or(""),
                issue["category"].as_str().unwrap_or("")
            ));
        }
    }
    lines.push(String::new());
    lines.push("## Issues on another forge".to_string());
    lines.push(String::new());
    if unowned.is_empty() {
        lines.push("None.".to_string());
    } else {
        for issue in &unowned {
            lines.push(format!(
                "- {} ({})",
                issue["url"].as_str().unwrap_or(""),
                issue["category"].as_str().unwrap_or("")
            ));
        }
    }
    lines.push(String::new());
    format!("{}\n", lines.join("\n"))
}

// ---------------------------------------------------------------------------
// Orphan reaper composition
// ---------------------------------------------------------------------------

/// How long a fresh detached-run handoff still belongs to its replacement.
pub const DETACHED_HANDOFF_GRACE_MS: i64 = 30_000;
/// How long a fresh goal-draft handoff still belongs to its replacement.
pub const GOAL_DRAFT_HANDOFF_GRACE_MS: i64 = 8_000;
const RUN_STATE_DEPTH: usize = 3;
const LOCK_DEPTH: usize = 4;

use crate::supervision::{
    reap_orphans, supervision_directory, OrphanSupervisor, OrphanSupervisorOptions, ReapAction,
    ReapDecision, ReapOptions, ReapReason, ReapReport, SupervisionScope, SUPERVISION_INTERVAL_MS,
};

/// Adds the owner and peer pids a run recorded under `directory`.
fn add_run_pids(directory: &Path, depth: usize, pids: &mut HashSet<u32>) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if depth > 1 {
                add_run_pids(&path, depth - 1, pids);
            }
            continue;
        }
        if entry.file_name().to_string_lossy() != "state.json" {
            continue;
        }
        let Some(parsed) = read_json(&path) else {
            continue;
        };
        let Some(record) = parsed.as_object() else {
            continue;
        };
        for key in ["owner", "peer"] {
            let Some(child) = record.get(key).and_then(Value::as_object) else {
                continue;
            };
            if let Some(pid) = child.get("pid").and_then(Value::as_i64) {
                if pid > 0 {
                    pids.insert(pid as u32);
                }
            }
        }
    }
}

fn is_lock_file_name(name: &str) -> bool {
    if name == "lock" || name.starts_with("lock.") {
        return true;
    }
    let Some(rest) = name
        .strip_prefix("devboard-")
        .and_then(|rest| rest.strip_suffix(".lock"))
    else {
        return false;
    };
    !rest.is_empty() && rest.bytes().all(|byte| byte.is_ascii_digit())
}

fn add_lock_pids(directory: &Path, depth: usize, pids: &mut HashSet<u32>) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if depth > 1 {
                add_lock_pids(&path, depth - 1, pids);
            }
            continue;
        }
        if !is_lock_file_name(&entry.file_name().to_string_lossy()) {
            continue;
        }
        for owner in live_lock_owners(&path) {
            pids.insert(owner.pid);
        }
    }
}

fn detached_lease_pid(state_dir: &Path, repo_dir: &Path) -> Option<u32> {
    let path = crate::detached_run::detached_run_lease_path(state_dir, repo_dir);
    measured_lease_pid(&path)
}

fn measured_lease_pid(path: &Path) -> Option<u32> {
    let parsed = read_json(path)?;
    let record = parsed.as_object()?;
    let pid = record.get("pid").and_then(Value::as_i64)?;
    record.get("updatedAt").and_then(Value::as_i64)?;
    if pid <= 0 {
        return None;
    }
    Some(pid as u32)
}

fn detached_handoff_at(state_dir: &Path, repo_dir: &Path) -> Option<i64> {
    let path = crate::detached_run::detached_run_handoff_path(state_dir, repo_dir);
    handoff_at(&path)
}

fn handoff_at(path: &Path) -> Option<i64> {
    let parsed = read_json(path)?;
    let record = parsed.as_object()?;
    record.get("pid").and_then(Value::as_i64)?;
    record.get("at").and_then(Value::as_i64)
}

fn goal_draft_state_directory(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    absolute(state_dir)
        .join("goal-drafts")
        .join(journal_key(&absolute(repo_dir)))
}

fn goal_draft_lease_pid(state_dir: &Path, repo_dir: &Path) -> Option<u32> {
    measured_lease_pid(&goal_draft_state_directory(state_dir, repo_dir).join("lease.json"))
}

fn goal_draft_handoff_at(state_dir: &Path, repo_dir: &Path) -> Option<i64> {
    handoff_at(&goal_draft_state_directory(state_dir, repo_dir).join("handoff.json"))
}

fn handoff_held(handoff: Option<i64>, grace_ms: i64, now: i64) -> bool {
    handoff.is_some_and(|at| now - at <= grace_ms)
}

/// Every pid a live detached run, goal-draft owner, or worker lock still
/// holds.
pub fn protected_pids(scopes: &[SupervisionScope]) -> HashSet<u32> {
    let mut pids = HashSet::new();
    let now = epoch_ms();
    for scope in scopes {
        let runs_held = detached_lease_pid(&scope.state_dir, &scope.repo_dir)
            .is_some_and(pid_alive)
            || handoff_held(
                detached_handoff_at(&scope.state_dir, &scope.repo_dir),
                DETACHED_HANDOFF_GRACE_MS,
                now,
            );
        if runs_held {
            add_run_pids(
                &crate::detached_run::detached_runs_root(&scope.state_dir, &scope.repo_dir),
                RUN_STATE_DEPTH,
                &mut pids,
            );
        }
        let drafts_held = goal_draft_lease_pid(&scope.state_dir, &scope.repo_dir)
            .is_some_and(pid_alive)
            || handoff_held(
                goal_draft_handoff_at(&scope.state_dir, &scope.repo_dir),
                GOAL_DRAFT_HANDOFF_GRACE_MS,
                now,
            );
        if drafts_held {
            add_run_pids(
                &goal_draft_state_directory(&scope.state_dir, &scope.repo_dir),
                RUN_STATE_DEPTH,
                &mut pids,
            );
        }
        add_lock_pids(&scope.state_dir, LOCK_DEPTH, &mut pids);
        add_lock_pids(
            &scope.repo_dir.join(".devboard").join(".tmp"),
            LOCK_DEPTH,
            &mut pids,
        );
    }
    pids
}

/// Every `(stateDir, repoDir)` one pass reads records and proofs from.
pub fn reaper_scopes(
    root: &Path,
    state_dir: Option<&Path>,
    instances: &[Instance],
) -> Vec<SupervisionScope> {
    let mut repos: HashMap<PathBuf, PathBuf> = HashMap::new();
    for instance in instances {
        repos.insert(
            absolute(Path::new(&instance.state_dir)),
            absolute(Path::new(&instance.repo_dir)),
        );
    }
    let mut scopes: Vec<SupervisionScope> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut add = |directory: &Path, repo_dir: PathBuf, scopes: &mut Vec<SupervisionScope>| {
        let real = absolute(directory);
        if !seen.insert(real.clone()) {
            return;
        }
        scopes.push(SupervisionScope {
            state_dir: real,
            repo_dir,
        });
    };
    let root = absolute(root);
    for covered in covered_state_dirs(&root, instances) {
        let repo_dir = repos
            .get(&absolute(&covered.state_dir))
            .cloned()
            .unwrap_or_else(|| root.clone());
        add(&covered.state_dir, repo_dir, &mut scopes);
    }
    if let Some(state_dir) = state_dir {
        add(state_dir, root, &mut scopes);
    }
    scopes
}

/// One reaping pass's inputs.
pub struct OrphanReaperRunOptions {
    pub root: PathBuf,
    /// The caller's own state directory, scanned even when nothing is live.
    pub state_dir: Option<PathBuf>,
    pub dry_run: bool,
    /// Test seam; production discovers the live dashboards itself.
    pub instances: Option<Vec<Instance>>,
    /// Test seam; production reads `/proc`.
    pub processes: Option<Vec<ProcessSnapshot>>,
    /// Test seam; production uses `/proc`.
    pub alive: Option<Box<dyn Fn(u32) -> bool + Send + Sync>>,
    pub orphan_grace_ms: Option<u64>,
    pub kill_grace_ms: Option<u64>,
}

impl OrphanReaperRunOptions {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            state_dir: None,
            dry_run: false,
            instances: None,
            processes: None,
            alive: None,
            orphan_grace_ms: None,
            kill_grace_ms: None,
        }
    }
}

fn decision_action(action: ReapAction) -> &'static str {
    match action {
        ReapAction::Killed => "killed",
        ReapAction::WouldKill => "would-kill",
        ReapAction::Skipped => "skipped",
        ReapAction::RemovedRecord => "removed-record",
    }
}

fn decision_reason(reason: ReapReason) -> &'static str {
    match reason {
        ReapReason::Record => "record",
        ReapReason::Scratch => "scratch",
    }
}

/// One durable line per candidate the reaper acted on or deliberately left.
fn log_decisions(state_dir: &Path, decisions: &[ReapDecision]) {
    let reportable: Vec<&ReapDecision> = decisions
        .iter()
        .filter(|decision| decision.action != ReapAction::RemovedRecord)
        .collect();
    if reportable.is_empty() {
        return;
    }
    let directory = supervision_directory(state_dir);
    let path = directory.join("reaped.jsonl");
    let _ = std::fs::create_dir_all(&directory);
    let now = now_iso();
    let mut text = String::new();
    for decision in reportable {
        text.push_str(&crate::jsjson::stringify(&json!({
            "ts": now,
            "action": decision_action(decision.action),
            "pid": decision.pid,
            "reason": decision_reason(decision.reason),
            "detail": decision.detail,
        })));
        text.push('\n');
    }
    let _ = append_line(&path, &text);
}

/// Performs the one reaping pass every dashboard start runs before serving.
///
/// The pass covers this dashboard's state directory, its checkout, and the
/// other covered directories; every kill and the pass itself are journaled
/// under `<STATE_DIR>/supervision/reaped.jsonl`. A live recorded child is
/// protected by the reaper's own proof and is never signalled.
pub fn reap_on_startup(state_dir: &Path, repo_dir: &Path) -> ReapReport {
    let mut options = OrphanReaperRunOptions::new(repo_dir);
    options.state_dir = Some(state_dir.to_path_buf());
    let report = run_orphan_reaper(options);
    log_startup_pass(state_dir, &report);
    report
}

/// Appends one pass record, so a start with nothing to kill is still visible.
fn log_startup_pass(state_dir: &Path, report: &ReapReport) {
    let directory = supervision_directory(state_dir);
    if std::fs::create_dir_all(&directory).is_err() {
        return;
    }
    let text = crate::jsjson::stringify(&json!({
        "ts": now_iso(),
        "pass": "startup",
        "available": report.available,
        "decisions": report.decisions.len(),
        "killed": report.killed,
        "removedRecords": report.removed_records,
    }));
    let _ = append_line(&directory.join("reaped.jsonl"), &format!("{text}\n"));
}

/// One reaping pass over every covered state directory.
pub fn run_orphan_reaper(mut options: OrphanReaperRunOptions) -> ReapReport {
    if !cfg!(target_os = "linux") {
        return ReapReport {
            available: false,
            decisions: Vec::new(),
            killed: Vec::new(),
            removed_records: Vec::new(),
        };
    }
    let root = absolute(&options.root);
    let instances = match &options.instances {
        Some(instances) => instances.clone(),
        None => {
            let mut self_pids = HashSet::from([std::process::id()]);
            self_pids.extend(ancestry(std::process::id(), 64));
            instances_from_processes(&process_table(), &self_pids)
        }
    };
    let scopes = reaper_scopes(&root, options.state_dir.as_deref(), &instances);
    let protected_pids = protected_pids(&scopes);
    let report = reap_orphans(ReapOptions {
        scopes,
        protected_pids,
        processes: options.processes.clone(),
        alive: options.alive.take(),
        dry_run: options.dry_run,
        orphan_grace_ms: options.orphan_grace_ms,
        kill_grace_ms: options.kill_grace_ms,
    });
    log_decisions(&root.join(".devboard").join(".tmp"), &report.decisions);
    if let Some(state_dir) = &options.state_dir {
        log_decisions(state_dir, &report.decisions);
    }
    report
}

/// The watchdog's activation: one pass now, then one every
/// `SUPERVISION_INTERVAL_MS`, independent of the cycle cadence.
pub fn start_orphan_reaper(
    root: &Path,
    state_dir: &Path,
    interval_ms: Option<u64>,
) -> OrphanSupervisor {
    let root = absolute(root);
    let state_dir = state_dir.to_path_buf();
    let reap = move || {
        let options = OrphanReaperRunOptions {
            root: root.clone(),
            state_dir: Some(state_dir.clone()),
            ..OrphanReaperRunOptions::new(root.clone())
        };
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_orphan_reaper(options);
        }));
    };
    let mut supervisor_options = OrphanSupervisorOptions::new(reap);
    supervisor_options.interval_ms = interval_ms;
    start_orphan_supervisor(supervisor_options)
}

// ---------------------------------------------------------------------------
// Read-only status and cycle history
// ---------------------------------------------------------------------------

/// The dashboard never lists more than the newest 100 run directories.
pub const CYCLE_HISTORY_LIMIT: usize = 100;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WatchdogCycleWindow {
    pub start: Option<String>,
    pub end: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WatchdogCycle {
    pub at: String,
    pub window: WatchdogCycleWindow,
    pub action: String,
    pub findings: usize,
    pub issues: Vec<String>,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WatchdogIssue {
    pub url: String,
    pub category: String,
    pub line: String,
    pub filed_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WatchdogStatus {
    pub cycle: Option<String>,
    pub action: String,
    pub reason: Option<String>,
    pub findings: usize,
    pub issues: Vec<WatchdogIssue>,
    pub pending: i64,
    pub cycles: Vec<WatchdogCycle>,
}

/// Resolves a finding fingerprint to the issue that covers it.
pub type WatchdogIssueResolver<'a> = &'a dyn Fn(&str) -> Option<String>;

fn cycle_window(value: Option<&Value>) -> WatchdogCycleWindow {
    let Some(window) = value.and_then(Value::as_object) else {
        return WatchdogCycleWindow::default();
    };
    WatchdogCycleWindow {
        start: window
            .get("start")
            .and_then(Value::as_str)
            .map(str::to_string),
        end: window
            .get("end")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

fn connected_issues(
    report: &serde_json::Map<String, Value>,
    resolve: Option<WatchdogIssueResolver<'_>>,
) -> Vec<String> {
    let mut urls: Vec<String> = Vec::new();
    let mut add = |value: Option<String>| {
        if let Some(url) = value {
            if !url.is_empty() && !urls.iter().any(|known| known == &url) {
                urls.push(url);
            }
        }
    };
    if let Some(findings) = report.get("findings").and_then(Value::as_array) {
        for value in findings {
            let Some(finding) = value.as_object() else {
                continue;
            };
            let Some(fingerprint) = finding.get("fingerprint").and_then(Value::as_str) else {
                continue;
            };
            add(resolve.and_then(|resolve| resolve(fingerprint)));
        }
    }
    if let Some(issues) = report.get("issues").and_then(Value::as_array) {
        for value in issues {
            add(value
                .as_object()
                .and_then(|issue| issue.get("url"))
                .and_then(Value::as_str)
                .map(str::to_string));
        }
    }
    urls
}

fn cycle_from_report(
    value: Option<&Value>,
    resolve: Option<WatchdogIssueResolver<'_>>,
) -> Option<WatchdogCycle> {
    let report = value?.as_object()?;
    let at = report.get("cycle").and_then(Value::as_str)?;
    if at.is_empty() {
        return None;
    }
    Some(WatchdogCycle {
        at: at.to_string(),
        window: cycle_window(report.get("window")),
        action: report
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("none")
            .to_string(),
        findings: report
            .get("findings")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0),
        issues: connected_issues(report, resolve),
        reason: report
            .get("reason")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

/// The cycle `latest.json` carries, when it carries a usable one.
pub fn latest_watchdog_cycle(
    latest: &Value,
    resolve: Option<WatchdogIssueResolver<'_>>,
) -> Option<WatchdogCycle> {
    cycle_from_report(Some(latest), resolve)
}

fn run_directories(watchdog_dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(watchdog_dir.join("runs")) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort_by(|left, right| right.cmp(left));
    names.truncate(CYCLE_HISTORY_LIMIT);
    names
}

/// The newest-first cycle history.
pub fn read_watchdog_cycles(
    watchdog_dir: &Path,
    latest_cycle: Option<&WatchdogCycle>,
    resolve: Option<WatchdogIssueResolver<'_>>,
) -> Vec<WatchdogCycle> {
    let directories = run_directories(watchdog_dir);
    if directories.is_empty() {
        return latest_cycle.cloned().into_iter().collect();
    }
    let mut cycles = Vec::new();
    for directory in directories {
        let report = read_json(
            &watchdog_dir
                .join("runs")
                .join(directory)
                .join("report.json"),
        );
        if let Some(cycle) = cycle_from_report(report.as_ref(), resolve) {
            cycles.push(cycle);
        }
    }
    cycles
}

/// The read-only watchdog view the dashboard serves.
pub fn read_watchdog_status(watchdog_dir: &Path) -> WatchdogStatus {
    let latest = read_json(&latest_path(watchdog_dir)).unwrap_or_else(|| json!({}));
    let ledger = load_ledger(watchdog_dir);
    let mut issues: Vec<WatchdogIssue> = ledger
        .findings
        .iter()
        .filter(|(_, entry)| entry.disposition.starts_with("filed:"))
        .filter_map(|(_, entry)| {
            let url = entry.url.clone()?;
            Some(WatchdogIssue {
                url,
                category: entry.category.clone(),
                line: entry.line.clone(),
                filed_at: entry
                    .filed_at
                    .clone()
                    .unwrap_or_else(|| entry.first_seen.clone()),
            })
        })
        .collect();
    issues.sort_by(|left, right| {
        right
            .filed_at
            .cmp(&left.filed_at)
            .then(left.url.cmp(&right.url))
    });
    let resolve = |fingerprint: &str| ledger.get(fingerprint).and_then(|entry| entry.url.clone());
    let latest_cycle = latest_watchdog_cycle(&latest, Some(&resolve));
    let cycles = read_watchdog_cycles(watchdog_dir, latest_cycle.as_ref(), Some(&resolve));
    WatchdogStatus {
        cycle: latest
            .get("cycle")
            .and_then(Value::as_str)
            .map(str::to_string),
        action: latest
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("none")
            .to_string(),
        reason: latest
            .get("reason")
            .and_then(Value::as_str)
            .map(str::to_string),
        findings: latest
            .get("findings")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0),
        issues,
        pending: ledger.pending_filing.len() as i64,
        cycles,
    }
}

// ---------------------------------------------------------------------------
// The detached worker
// ---------------------------------------------------------------------------

/// One cycle's resolved inputs inside the worker.
#[derive(Clone, Debug)]
pub struct CycleRunRequest {
    pub root: PathBuf,
    /// The machine-level watchdog directory.
    pub state_dir: PathBuf,
    /// The dashboard STATE_DIR whose projection the worker refreshes.
    pub provider_state_dir: PathBuf,
    pub window_ms: u64,
    pub settings: WatchdogSettings,
}

pub type CycleRunner = Arc<dyn Fn(&CycleRunRequest) -> anyhow::Result<Report> + Send + Sync>;
pub type SupervisorFactory = Arc<dyn Fn(&Path, &Path, u64) -> OrphanSupervisor + Send + Sync>;

/// The production cycle: discover, prune, sweep, collect, and file.
pub fn production_cycle(request: &CycleRunRequest) -> anyhow::Result<Report> {
    let options = CycleOptions {
        root: request.root.clone(),
        now_ms: epoch_ms(),
        state_dir: Some(request.state_dir.clone()),
        dry_run: false,
        window_ms: Some(request.window_ms),
        settings: Some(request.settings.clone()),
        provider_state_dir: Some(request.provider_state_dir.clone()),
        environment: std::env::vars().collect(),
    };
    let deps = CycleDeps::production();
    Ok(run_cycle(&options, &deps)?.report)
}

#[derive(Clone)]
pub struct WatchdogWorkerOptions {
    pub root: PathBuf,
    /// The machine-level watchdog directory.
    pub state_dir: PathBuf,
    /// The dashboard STATE_DIR whose projection the worker refreshes.
    pub owner_state_dir: PathBuf,
    pub harness_version: Option<String>,
    /// Test seam; production runs the real cycle.
    pub cycle: Option<CycleRunner>,
    /// Test seam; production starts the orphan reaper on its own interval.
    pub supervisor: Option<SupervisorFactory>,
    pub poll_ms: u64,
}

impl WatchdogWorkerOptions {
    pub fn new(
        root: impl Into<PathBuf>,
        state_dir: impl Into<PathBuf>,
        owner_state_dir: impl Into<PathBuf>,
    ) -> Self {
        Self {
            root: root.into(),
            state_dir: state_dir.into(),
            owner_state_dir: owner_state_dir.into(),
            harness_version: None,
            cycle: None,
            supervisor: None,
            poll_ms: CONTROL_POLL_MS,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WatchdogWorkerResult {
    /// False when a live worker of this version already holds the lock.
    pub acquired: bool,
    pub owner_pid: Option<u32>,
}

struct WorkerLoop {
    root: PathBuf,
    state_dir: PathBuf,
    owner_state_dir: PathBuf,
    version: Option<String>,
    directory: PathBuf,
    argv: Vec<String>,
    started_at: String,
    settings: WatchdogSettings,
    stopping: bool,
    draining: bool,
    last_run_at: Option<String>,
    next_run_at: Option<String>,
    last_error: Option<String>,
    notice: Option<String>,
}

impl WorkerLoop {
    fn publish(&self, lifecycle: AgentLifecycle, enabled: bool) {
        let state = WatchdogWorkerState {
            version: WORKER_STATE_VERSION,
            pid: std::process::id(),
            started_at: self.started_at.clone(),
            root: self.root.to_string_lossy().into_owned(),
            state_dir: self.owner_state_dir.to_string_lossy().into_owned(),
            lifecycle,
            enabled,
            harness_version: self.version.clone(),
            argv: self.argv.clone(),
            last_run_at: self.last_run_at.clone(),
            next_run_at: self.next_run_at.clone(),
            last_error: self.last_error.clone(),
            notice: self.notice.clone(),
            draining: self.draining,
            updated_at: now_iso(),
        };
        let _ = write_worker_state(&self.directory, &state);
    }

    fn cadence(&self) -> i64 {
        (self.settings.interval_minutes * 60_000).max(60_000)
    }

    fn recompute_next(&mut self) {
        self.next_run_at = Some(match self.last_run_at.as_deref().and_then(parse_iso_ms) {
            Some(start) => iso_from_ms(start + self.cadence()),
            None => now_iso(),
        });
    }

    /// The dashboard's Stop writes a control command; a signal is the same
    /// request.
    fn request_stop(&mut self) {
        if self.stopping {
            return;
        }
        self.stopping = true;
        self.publish(AgentLifecycle::Stopping, false);
    }

    /// A newer version owns new work; finish the in-flight cycle, then exit.
    fn request_drain(&mut self) {
        if self.stopping {
            self.draining = true;
            self.publish(AgentLifecycle::Stopping, false);
            return;
        }
        self.draining = true;
        self.notice = Some(
            "Draining: the newer harness owns new cycles; finishing the in-flight cycle, then exiting."
                .to_string(),
        );
        self.request_stop();
    }

    fn apply(&mut self, command: WatchdogCommand) {
        match command {
            WatchdogCommand::Stop => self.request_stop(),
            WatchdogCommand::Drain => self.request_drain(),
            WatchdogCommand::Settings {
                interval_minutes,
                max_per_hour,
                max_pending,
            } => {
                self.settings = WatchdogSettings {
                    interval_minutes,
                    max_per_hour,
                    max_pending,
                };
                let _ = write_watchdog_settings(&self.state_dir, &self.settings);
                self.recompute_next();
                self.notice = Some(format!(
                    "Settings saved: every {interval_minutes} minute(s)."
                ));
                self.publish(AgentLifecycle::Running, true);
            }
        }
    }

    /// A versioned worker still consumes the legacy control directory an older
    /// dashboard may write, unless a pre-version worker is live.
    fn legacy_worker_live(&self) -> bool {
        let self_pid = std::process::id();
        let lock = live_lock_owners(&lock_path(&self.state_dir));
        if lock
            .iter()
            .any(|owner| owner.harness_version.is_none() && owner.pid != self_pid)
        {
            return true;
        }
        read_worker_state(&self.state_dir).is_some_and(|state| {
            state.pid != self_pid
                && state.lifecycle != AgentLifecycle::Stopped
                && pid_alive(state.pid)
        })
    }

    fn consume(&mut self) {
        for command in take_watchdog_commands(&versioned_control_directory(
            &self.state_dir,
            self.version.as_deref(),
        )) {
            self.apply(command);
        }
        if !self.legacy_worker_live() && control_directory(&self.state_dir).exists() {
            for command in take_watchdog_commands(&control_directory(&self.state_dir)) {
                self.apply(command);
            }
        }
    }
}

fn spawn_signal_listener(
    sender: tokio::sync::mpsc::UnboundedSender<()>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};
            let Ok(mut terminate) = signal(SignalKind::terminate()) else {
                return;
            };
            let Ok(mut interrupt) = signal(SignalKind::interrupt()) else {
                return;
            };
            tokio::select! {
                _ = terminate.recv() => {}
                _ = interrupt.recv() => {}
            }
            let _ = sender.send(());
        }
        #[cfg(not(unix))]
        {
            let _ = sender;
        }
    })
}

async fn run_cycle_blocking(
    cycle: &CycleRunner,
    request: CycleRunRequest,
) -> anyhow::Result<Report> {
    let cycle = Arc::clone(cycle);
    match tokio::task::spawn_blocking(move || cycle(&request)).await {
        Ok(result) => result,
        Err(error) => Err(anyhow::anyhow!("the watchdog cycle task failed: {error}")),
    }
}

/// The dashboard-started detached watchdog worker. One instance exists per
/// harness version per host root; a newer version's worker can run beside an
/// older one during a takeover, so the versioned lock plus the cycle lease are
/// what keep one unit from being claimed twice.
pub async fn run_worker(options: WatchdogWorkerOptions) -> WatchdogWorkerResult {
    let root = absolute(&options.root);
    let state_dir = absolute(&options.state_dir);
    let owner_state_dir = absolute(&options.owner_state_dir);
    let version = options.harness_version.clone();
    let poll_ms = if options.poll_ms == 0 {
        CONTROL_POLL_MS
    } else {
        options.poll_ms
    };
    let directory = versioned_worker_directory(&state_dir, version.as_deref());
    let details = LockDetails {
        repo: root.to_string_lossy().into_owned(),
        state_dir: owner_state_dir.to_string_lossy().into_owned(),
        harness_version: version.clone(),
        argv: std::env::args().collect(),
    };
    let lock = match acquire_worker_lock(&lock_path(&state_dir), version.as_deref(), &details) {
        LockResult::Acquired(handle) => handle,
        LockResult::Busy(owner) => {
            return WatchdogWorkerResult {
                acquired: false,
                owner_pid: owner.map(|owner| owner.pid),
            }
        }
    };

    // Orphans are reaped on their own interval, not once per cycle.
    let supervisor_factory: SupervisorFactory = options.supervisor.clone().unwrap_or_else(|| {
        Arc::new(|root: &Path, state_dir: &Path, interval_ms: u64| {
            start_orphan_reaper(root, state_dir, Some(interval_ms))
        })
    });
    let mut supervisor = supervisor_factory(&root, &owner_state_dir, SUPERVISION_INTERVAL_MS);

    // The predecessor's cadence is the family's cadence.
    let previous = read_newest_worker_state(&state_dir);
    let mut state = WorkerLoop {
        root: root.clone(),
        state_dir: state_dir.clone(),
        owner_state_dir: owner_state_dir.clone(),
        version: version.clone(),
        directory,
        argv: std::env::args().collect(),
        started_at: now_iso(),
        settings: read_watchdog_settings(&state_dir),
        stopping: false,
        draining: false,
        last_run_at: previous
            .as_ref()
            .and_then(|state| state.last_run_at.clone()),
        next_run_at: None,
        last_error: None,
        notice: None,
    };
    state.recompute_next();
    state.publish(AgentLifecycle::Running, true);

    let cycle: CycleRunner = options
        .cycle
        .clone()
        .unwrap_or_else(|| Arc::new(production_cycle));
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel::<()>();
    let signal_task = spawn_signal_listener(sender);

    loop {
        if state.stopping {
            break;
        }
        state.consume();
        if state.stopping {
            break;
        }
        let now = epoch_ms();
        let next = state.next_run_at.as_deref().and_then(parse_iso_ms);
        let due = next.map(|next| now >= next).unwrap_or(true);
        if due {
            let Some(claim) = claim_cycle(&cycle_claim_path(&state_dir), version.as_deref()) else {
                // Another version's in-flight cycle owns this unit. Adopt its
                // cadence so the family runs one cycle, not one per version.
                if let Some(winner) = read_newest_worker_state(&state_dir) {
                    if winner.last_run_at.is_some() {
                        state.last_run_at = winner.last_run_at.clone();
                        state.recompute_next();
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(poll_ms)).await;
                continue;
            };
            let run_started = now_iso();
            state.last_run_at = Some(run_started.clone());
            state.settings = read_watchdog_settings(&state_dir);
            let cadence = state.cadence();
            state.next_run_at = Some(iso_from_ms(
                parse_iso_ms(&run_started).unwrap_or(now) + cadence,
            ));
            state.publish(AgentLifecycle::Running, true);
            let request = CycleRunRequest {
                root: root.clone(),
                state_dir: state_dir.clone(),
                provider_state_dir: owner_state_dir.clone(),
                window_ms: cadence.max(60_000) as u64,
                settings: state.settings.clone(),
            };
            match run_cycle_blocking(&cycle, request).await {
                Ok(report) => {
                    state.last_error = if report.action() == "failed" {
                        report.reason().map(str::to_string)
                    } else {
                        None
                    };
                    state.notice = report.reason().map(str::to_string);
                }
                Err(error) => state.last_error = Some(error.to_string()),
            }
            state.consume();
            if state.stopping {
                claim.release();
                break;
            }
            state.settings = read_watchdog_settings(&state_dir);
            state.recompute_next();
            state.publish(AgentLifecycle::Running, true);
            claim.release();
            continue;
        }
        let wait = next
            .map(|next| (next - now).clamp(1, poll_ms as i64))
            .unwrap_or(poll_ms as i64);
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_millis(wait as u64)) => {}
            _ = receiver.recv() => state.request_stop(),
        }
    }

    supervisor.stop();
    signal_task.abort();
    state.consume();
    state.publish(AgentLifecycle::Stopped, false);
    lock.release();
    WatchdogWorkerResult {
        acquired: true,
        owner_pid: None,
    }
}

// ---------------------------------------------------------------------------
// Environment and CLI
// ---------------------------------------------------------------------------

fn parse_quoted(value: &str, quote: char) -> (String, usize) {
    let mut out = String::new();
    let mut escaped = false;
    for (index, character) in value.char_indices().skip(1) {
        if escaped {
            out.push(match character {
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                other => other,
            });
            escaped = false;
            continue;
        }
        if character == '\\' && quote == '"' {
            escaped = true;
            continue;
        }
        if character == quote {
            return (out, index + character.len_utf8());
        }
        out.push(character);
    }
    (out, value.len())
}

/// The key/value pairs of one dotenv file, as `node:util`'s `parseEnv` reads
/// the forms the operator writes.
pub fn parse_environment(text: &str) -> Vec<(String, String)> {
    let mut values = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line).trim();
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        let value = value.trim_start();
        let parsed = if let Some(rest) = value.strip_prefix('"') {
            parse_quoted(&format!("\"{rest}"), '"').0
        } else if let Some(rest) = value.strip_prefix('\'') {
            parse_quoted(&format!("'{rest}"), '\'').0
        } else {
            match value.find(" #") {
                Some(index) => value[..index].trim_end().to_string(),
                None => value.trim_end().to_string(),
            }
        };
        values.push((key.to_string(), parsed));
    }
    values
}

/// Loads `<root>/.env` without overriding a value the caller already set.
pub fn load_root_environment(root: &Path) {
    let Ok(text) = std::fs::read_to_string(root.join(".env")) else {
        return;
    };
    for (key, value) in parse_environment(&text) {
        if std::env::var_os(&key).is_none() {
            std::env::set_var(key, value);
        }
    }
}

fn git_top_level() -> Option<PathBuf> {
    let current = std::env::current_dir().ok()?;
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(&current)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let top = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!top.is_empty()).then(|| PathBuf::from(top))
}

fn flag(invocation: &WorkerInvocation, name: &str) -> bool {
    invocation.rest.iter().any(|argument| argument == name)
}

/// Runs the watchdog worker family.
///
/// `devboard worker watchdog --repo <root> --state-dir <dir>` runs the
/// detached worker. `--once`, `--collect --dry-run`, and `--processes` are the
/// operator paths.
pub async fn run(invocation: &WorkerInvocation) -> anyhow::Result<()> {
    let root_option = if invocation.repo_dir.as_os_str().is_empty() {
        git_top_level()
    } else {
        Some(absolute(&invocation.repo_dir))
    };
    let Some(root) = root_option else {
        eprintln!("watchdog worker: the harness is not inside a git checkout");
        std::process::exit(2);
    };
    if !root.join(".devboard").is_dir() {
        eprintln!(
            "watchdog worker: missing prerequisite: {} does not exist",
            root.join(".devboard").display()
        );
        std::process::exit(2);
    }
    // systemd starts this process in the harness directory with only PATH, so
    // the host root's `.env` must be read here. Explicit values still win.
    load_root_environment(&root);

    let state_dir = if invocation.state_dir.as_os_str().is_empty() {
        watchdog_directory(&root)
    } else {
        absolute(&invocation.state_dir)
    };
    let owner_state_dir = invocation
        .option("owner-state-dir")
        .map(PathBuf::from)
        .map(|path| absolute(&path))
        .unwrap_or_else(|| state_dir.clone());
    let harness_version = std::env::var("DEVBOARD_HARNESS_VERSION")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| read_harness_version(&root.join(".devboard")));

    let once = flag(invocation, "--once");
    let collect = flag(invocation, "--collect");
    let dry_run = flag(invocation, "--dry-run");
    let processes = flag(invocation, "--processes");

    if collect && !dry_run {
        eprintln!("watchdog: --collect runs with --dry-run");
        std::process::exit(2);
    }
    if once && (collect || dry_run) {
        eprintln!("watchdog: --once and --dry-run are exclusive");
        std::process::exit(2);
    }

    if processes {
        let mut options = OrphanReaperRunOptions::new(root.clone());
        options.state_dir = Some(state_dir.clone());
        options.dry_run = !once;
        let report = run_orphan_reaper(options);
        for decision in &report.decisions {
            if decision.action == ReapAction::WouldKill {
                println!(
                    "cleanup: would kill {} ({}): {}",
                    decision.pid,
                    decision_reason(decision.reason),
                    decision.detail
                );
            } else if decision.action == ReapAction::Killed {
                println!(
                    "cleanup: killed {} ({}): {}",
                    decision.pid,
                    decision_reason(decision.reason),
                    decision.detail
                );
            }
        }
        std::process::exit(0);
    }

    if once || collect || dry_run {
        let settings = read_watchdog_settings(&state_dir);
        let details = LockDetails {
            repo: root.to_string_lossy().into_owned(),
            state_dir: state_dir.to_string_lossy().into_owned(),
            harness_version: harness_version.clone(),
            argv: std::env::args().collect(),
        };
        let lock =
            match acquire_worker_lock(&lock_path(&state_dir), harness_version.as_deref(), &details)
            {
                LockResult::Acquired(handle) => handle,
                LockResult::Busy(owner) => {
                    match owner {
                        Some(owner) => println!("watchdog: already running (pid {})", owner.pid),
                        None => println!("watchdog: already running"),
                    }
                    std::process::exit(0);
                }
            };
        let claim = if dry_run || collect {
            None
        } else {
            claim_cycle(&cycle_claim_path(&state_dir), harness_version.as_deref())
        };
        if claim.is_none() && !dry_run && !collect {
            println!("watchdog: another worker is running a cycle; try again shortly");
            lock.release();
            std::process::exit(0);
        }
        let options = CycleOptions {
            root: root.clone(),
            now_ms: epoch_ms(),
            state_dir: Some(state_dir.clone()),
            dry_run: dry_run || collect,
            window_ms: Some((settings.interval_minutes * 60_000).max(60_000) as u64),
            settings: Some(settings),
            provider_state_dir: Some(owner_state_dir.clone()),
            environment: std::env::vars().collect(),
        };
        let result = run_cycle(&options, &CycleDeps::production());
        let exit_code = match result {
            Ok(result) => {
                if dry_run || collect {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&result.report.value).unwrap_or_default()
                    );
                }
                result.exit_code
            }
            Err(error) => {
                eprintln!("watchdog: {error}");
                1
            }
        };
        if let Some(claim) = claim {
            claim.release();
        }
        lock.release();
        std::process::exit(exit_code);
    }

    let result = run_worker(WatchdogWorkerOptions {
        root,
        state_dir,
        owner_state_dir,
        harness_version,
        cycle: None,
        supervisor: None,
        poll_ms: CONTROL_POLL_MS,
    })
    .await;
    if !result.acquired {
        eprintln!(
            "watchdog worker: already running for this version{}",
            result
                .owner_pid
                .map(|pid| format!(" (pid {pid})"))
                .unwrap_or_default()
        );
    }
    std::process::exit(0);
}
