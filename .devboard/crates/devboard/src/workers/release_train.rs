//! The detached Release Train worker.
//!
//! One worker exists per repository and harness version. Every tick runs one
//! deterministic gate and starts exactly one release run only when the gate
//! finds a non-merge commit after the newest release tag. The worker never
//! starts a run while another is active, and a failed release leaves its range
//! unreleased for the next due tick.
//!
//! Everything the family owns lives under `<STATE_DIR>/release-train/`: the
//! shared state, settings, this version's worker record and control channel,
//! the family's run lease, and one directory per run. The dashboard reads the
//! files without a worker and writes commands as individual JSON files.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::forge::{
    gitea_git_anonymous_environment, gitea_git_credential, gitea_git_environment,
    GiteaGitCredential,
};
use crate::publish::{MANIFEST_CHECKSUM_ASSET, RELEASE_INSTALLERS, RELEASE_TARGETS};
use crate::release::MANIFEST_ASSET;

use super::WorkerInvocation;

/* ------------------------------------------------------------------------ */
/* Files and directories                                                     */
/* ------------------------------------------------------------------------ */

/// The family's directory under the dashboard's state directory.
pub const RELEASE_TRAIN_DIRECTORY: &str = "release-train";
pub const WORKERS_DIRECTORY: &str = "workers";
pub const RUNS_DIRECTORY: &str = "runs";
pub const STATE_VERSION: i64 = 1;
pub const WORKER_VERSION: i64 = 1;
pub const RUN_VERSION: i64 = 1;
/// The scheduled release cadence.
pub const DEFAULT_INTERVAL_MINUTES: i64 = 10;
pub const CADENCE_MIN_MINUTES: i64 = 1;
pub const CADENCE_MAX_MINUTES: i64 = 1440;
pub const LIMIT_MIN: i64 = 1;
pub const LIMIT_MAX: i64 = 100;
pub const TICK_MS: u64 = 1_000;
const CONTROL_POLL_MS: u64 = 250;
/// How long the release peer may stay silent before the run is treated as
/// stuck. A release legitimately compiles, rebuilds the client, runs the
/// workspace suite up to nine times, and waits for the workflow, so the bound
/// is silence rather than total runtime: a peer that keeps reporting progress
/// is working and is never failed mid-release.
const RUN_SILENCE_MS: u64 = 60 * 60_000;
/// The outer bound on one release run, however busy its peer stays. It only
/// stops a peer that reports progress forever without ever finishing.
const RUN_MAX_MS: u64 = 4 * 60 * 60_000;
const RUN_BUSY_NOTICE: &str = "Another Release Train run is active; this tick starts nothing.";
pub const RUN_HISTORY_LIMIT: usize = 20;
pub const ACTIVITY_MAX_ENTRIES: usize = 200;
pub const ACTIVITY_MAX_BYTES: usize = 96 * 1024;

/// `<state-dir>/release-train`.
pub fn release_train_directory(state_dir: &Path) -> PathBuf {
    state_dir.join(RELEASE_TRAIN_DIRECTORY)
}

pub fn state_path(directory: &Path) -> PathBuf {
    directory.join("state.json")
}

pub fn settings_path(directory: &Path) -> PathBuf {
    directory.join("settings.json")
}

/// The shared worker lock; each version gets its own beside it.
pub fn lock_path(directory: &Path) -> PathBuf {
    directory.join("lock")
}

/// A version-safe segment for a lock file or worker directory.
pub fn worker_version_key(version: Option<&str>) -> String {
    let text = match version {
        Some(text) if !text.is_empty() => text,
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

pub fn versioned_lock_path(directory: &Path, version: Option<&str>) -> PathBuf {
    PathBuf::from(format!(
        "{}.{}",
        lock_path(directory).display(),
        worker_version_key(version)
    ))
}

pub fn versioned_worker_directory(directory: &Path, version: Option<&str>) -> PathBuf {
    directory
        .join(WORKERS_DIRECTORY)
        .join(worker_version_key(version))
}

pub fn versioned_worker_state_path(directory: &Path, version: Option<&str>) -> PathBuf {
    versioned_worker_directory(directory, version).join("worker.json")
}

pub fn versioned_control_directory(directory: &Path, version: Option<&str>) -> PathBuf {
    versioned_worker_directory(directory, version).join("control")
}

/// Every version's worker directory under one release-train directory.
pub fn worker_state_directories(directory: &Path) -> Vec<PathBuf> {
    let root = directory.join(WORKERS_DIRECTORY);
    let mut directories: Vec<PathBuf> = std::fs::read_dir(&root)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.path().is_dir())
                .map(|entry| entry.path())
                .collect()
        })
        .unwrap_or_default();
    directories.sort();
    directories
}

/// One lease for the single run the family may execute at a time.
pub fn run_lock_path(directory: &Path) -> PathBuf {
    directory.join("run.lock")
}

pub fn runs_directory(directory: &Path) -> PathBuf {
    directory.join(RUNS_DIRECTORY)
}

pub fn run_directory(directory: &Path, id: &str) -> PathBuf {
    runs_directory(directory).join(id)
}

/// The range, target, version, and commits the run is handed.
pub fn request_path(directory: &Path, id: &str) -> PathBuf {
    run_directory(directory, id).join("request.json")
}

pub fn activity_path(directory: &Path, id: &str) -> PathBuf {
    run_directory(directory, id).join("activity.json")
}

/// The activity file of the run the worker record names as active. The
/// Release Train keeps one directory per run instead of a cycle directory, so
/// the state's own `activeRun` is the only id the path needs.
pub fn state_activity_path(directory: &Path, state: &Value) -> Option<PathBuf> {
    let id = state.get("activeRun").and_then(Value::as_str)?;
    Some(activity_path(directory, id))
}

/// The run's optional outcome document; the worker verifies it itself.
pub fn result_path(directory: &Path, id: &str) -> PathBuf {
    run_directory(directory, id).join("result.json")
}

/* ------------------------------------------------------------------------ */
/* Time                                                                      */
/* ------------------------------------------------------------------------ */

static ISO_FORMAT: LazyLock<&'static [time::format_description::BorrowedFormatItem<'static>]> =
    LazyLock::new(|| {
        time::macros::format_description!(
            "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
        )
    });

fn iso_format() -> &'static [time::format_description::BorrowedFormatItem<'static>] {
    *ISO_FORMAT
}

/// One instant as `Date.prototype.toISOString()` writes it.
pub fn iso_from_millis(millis: i64) -> String {
    let nanos = millis as i128 * 1_000_000;
    match time::OffsetDateTime::from_unix_timestamp_nanos(nanos) {
        Ok(at) => at
            .to_offset(time::UtcOffset::UTC)
            .format(iso_format())
            .unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".to_string()),
        Err(_) => "1970-01-01T00:00:00.000Z".to_string(),
    }
}

/// The epoch milliseconds `Date.parse` would read from an ISO timestamp.
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
    let mut index = 10;
    let mut seconds_of_day = 0i64;
    let mut fraction_ms = 0i64;
    if matches!(bytes.get(index), Some(b'T') | Some(b' ')) {
        index += 1;
        let hour = digits(index, index + 2)?;
        let minute = digits(index + 3, index + 5)?;
        let second = digits(index + 6, index + 8)?;
        if hour > 23 || minute > 59 || second > 60 {
            return None;
        }
        seconds_of_day = hour * 3_600 + minute * 60 + second;
        index += 8;
        if bytes.get(index) == Some(&b'.') {
            index += 1;
            let start = index;
            while matches!(bytes.get(index), Some(byte) if byte.is_ascii_digit()) {
                index += 1;
            }
            let digits = text.get(start..index)?;
            if digits.is_empty() {
                return None;
            }
            let mut padded: String = digits.chars().take(3).collect();
            while padded.len() < 3 {
                padded.push('0');
            }
            fraction_ms = padded.parse().ok()?;
        }
    }
    let mut offset_minutes = 0i64;
    match bytes.get(index) {
        None | Some(b'Z') | Some(b'z') => {}
        Some(sign @ (b'+' | b'-')) => {
            let sign = if *sign == b'-' { -1 } else { 1 };
            let hours = digits(index + 1, index + 3)?;
            let minutes = if bytes.get(index + 3) == Some(&b':') {
                digits(index + 4, index + 6)?
            } else {
                digits(index + 3, index + 5)?
            };
            offset_minutes = sign * (hours * 60 + minutes);
        }
        _ => return None,
    }
    let days = days_from_civil(year, month, day);
    Some(days * 86_400_000 + seconds_of_day * 1_000 + fraction_ms - offset_minutes * 60_000)
}

/// The epoch day of one civil date (Howard Hinnant's `days_from_civil`).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = (month + 9) % 12;
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// A wall clock, injectable for the tests.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/* ------------------------------------------------------------------------ */
/* Settings                                                                  */
/* ------------------------------------------------------------------------ */

/// The Release Train's cadence and filing caps.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseTrainSettings {
    pub interval_minutes: i64,
    pub max_per_hour: Option<i64>,
    pub max_pending: Option<i64>,
}

impl Default for ReleaseTrainSettings {
    fn default() -> Self {
        Self {
            interval_minutes: DEFAULT_INTERVAL_MINUTES,
            max_per_hour: None,
            max_pending: None,
        }
    }
}

impl ReleaseTrainSettings {
    pub fn to_json(&self) -> Value {
        json!({
            "intervalMinutes": self.interval_minutes,
            "maxPerHour": self.max_per_hour,
            "maxPending": self.max_pending,
        })
    }
}

pub fn is_integer(value: &Value) -> bool {
    value.as_i64().is_some() || value.as_u64().is_some()
}

pub fn is_valid_cadence(value: &Value) -> bool {
    value
        .as_i64()
        .map(|number| (CADENCE_MIN_MINUTES..=CADENCE_MAX_MINUTES).contains(&number))
        .unwrap_or(false)
}

pub fn is_valid_limit(value: &Value) -> bool {
    value.is_null()
        || value
            .as_i64()
            .map(|number| (LIMIT_MIN..=LIMIT_MAX).contains(&number))
            .unwrap_or(false)
}

pub fn parse_settings(text: &str) -> Option<ReleaseTrainSettings> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    parsed.as_object()?;
    let interval = parsed
        .get("intervalMinutes")
        .filter(|value| is_valid_cadence(value))
        .and_then(Value::as_i64)
        .unwrap_or(DEFAULT_INTERVAL_MINUTES);
    let limit = |key: &str| {
        parsed
            .get(key)
            .filter(|value| is_valid_limit(value))
            .and_then(Value::as_i64)
    };
    Some(ReleaseTrainSettings {
        interval_minutes: interval,
        max_per_hour: limit("maxPerHour"),
        max_pending: limit("maxPending"),
    })
}

/// A missing or invalid file falls back to the defaults; it never prevents a
/// tick.
pub fn read_settings(directory: &Path) -> ReleaseTrainSettings {
    std::fs::read_to_string(settings_path(directory))
        .ok()
        .and_then(|text| parse_settings(&text))
        .unwrap_or_default()
}

pub fn write_settings(directory: &Path, settings: &ReleaseTrainSettings) -> std::io::Result<()> {
    write_json_atomic(&settings_path(directory), &settings.to_json())
}

/* ------------------------------------------------------------------------ */
/* JSON files                                                                */
/* ------------------------------------------------------------------------ */

fn temporary_name(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(format!(".{}.tmp", std::process::id()));
    PathBuf::from(name)
}

/// Writes one document the way `JSON.stringify(value, null, 2)` plus a newline
/// leaves it: created through a temporary name and renamed into place.
pub fn write_json_atomic(path: &Path, value: &Value) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = temporary_name(path);
    let text = serde_json::to_string_pretty(value)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    std::fs::write(&temporary, format!("{text}\n"))?;
    std::fs::rename(&temporary, path)
}

/* ------------------------------------------------------------------------ */
/* State                                                                     */
/* ------------------------------------------------------------------------ */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReleaseTrainGateState {
    Nothing,
    Unreleased,
    Error,
}

impl ReleaseTrainGateState {
    pub fn as_str(self) -> &'static str {
        match self {
            ReleaseTrainGateState::Nothing => "nothing",
            ReleaseTrainGateState::Unreleased => "unreleased",
            ReleaseTrainGateState::Error => "error",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReleaseTrainRunState {
    Running,
    Released,
    Failed,
    Nothing,
    Error,
}

impl ReleaseTrainRunState {
    pub fn as_str(self) -> &'static str {
        match self {
            ReleaseTrainRunState::Running => "running",
            ReleaseTrainRunState::Released => "released",
            ReleaseTrainRunState::Failed => "failed",
            ReleaseTrainRunState::Nothing => "nothing",
            ReleaseTrainRunState::Error => "error",
        }
    }

    /// Whether the run has ended. A state that is not `running` was settled by
    /// the worker that owned the run, so a later write carrying `running` is
    /// only a stale copy of the earlier snapshot.
    fn settled(self) -> bool {
        self != ReleaseTrainRunState::Running
    }
}

/// The newest verified release.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseTrainRelease {
    pub version: String,
    pub url: String,
    pub at: String,
    pub sha: String,
    pub range: String,
}

/// The newest failed release, kept until a later run succeeds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseTrainFailure {
    pub at: String,
    pub detail: String,
    pub sha: String,
    pub range: String,
    /// The version the failed range would have released, when known.
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseTrainGateRecord {
    pub at: String,
    pub state: ReleaseTrainGateState,
    pub detail: Option<String>,
    pub target: Option<String>,
    pub range: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseTrainRun {
    pub id: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub state: ReleaseTrainRunState,
    pub range: String,
    pub target: String,
    pub version: Option<String>,
    pub url: Option<String>,
    pub detail: Option<String>,
    /// Non-merge commits in the range; null when the gate carried no list.
    pub commits: Option<i64>,
    /// The release agent this run started, when it started one.
    #[serde(default)]
    pub peer: Option<ReleasePeer>,
}

/// The release agent a run owns: the process Stop ends.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleasePeer {
    pub command: String,
    pub pid: u32,
    pub argv: Vec<String>,
    pub started_at: String,
}

/// The Release Train's shared, durable record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseTrainState {
    pub version: i64,
    pub repo: String,
    pub root: String,
    pub release: Option<ReleaseTrainRelease>,
    pub failure: Option<ReleaseTrainFailure>,
    pub gate: Option<ReleaseTrainGateRecord>,
    /// Newest run first, bounded.
    pub runs: Vec<ReleaseTrainRun>,
    /// The newest activity lines, oldest first, bounded.
    pub activity: Vec<String>,
    pub updated_at: String,
}

pub fn empty_state(repo: &str, root: &str, now_ms: i64) -> ReleaseTrainState {
    ReleaseTrainState {
        version: STATE_VERSION,
        repo: repo.to_string(),
        root: root.to_string(),
        release: None,
        failure: None,
        gate: None,
        runs: Vec::new(),
        activity: Vec::new(),
        updated_at: iso_from_millis(now_ms),
    }
}

fn nullable_string(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Null) | Some(Value::String(_)))
}

fn string_list(value: Option<&Value>) -> Option<Vec<String>> {
    let entries = value?.as_array()?;
    let mut lines = Vec::with_capacity(entries.len());
    for entry in entries {
        lines.push(entry.as_str()?.to_string());
    }
    Some(lines)
}

fn parse_release(value: &Value) -> Option<ReleaseTrainRelease> {
    let object = value.as_object()?;
    Some(ReleaseTrainRelease {
        version: object.get("version")?.as_str()?.to_string(),
        url: object.get("url")?.as_str()?.to_string(),
        at: object.get("at")?.as_str()?.to_string(),
        sha: object.get("sha")?.as_str()?.to_string(),
        range: object.get("range")?.as_str()?.to_string(),
    })
}

fn parse_failure(value: &Value) -> Option<ReleaseTrainFailure> {
    let object = value.as_object()?;
    if !nullable_string(object.get("version")) {
        return None;
    }
    Some(ReleaseTrainFailure {
        at: object.get("at")?.as_str()?.to_string(),
        detail: object.get("detail")?.as_str()?.to_string(),
        sha: object.get("sha")?.as_str()?.to_string(),
        range: object.get("range")?.as_str()?.to_string(),
        version: object
            .get("version")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn parse_gate_record(value: &Value) -> Option<ReleaseTrainGateRecord> {
    let object = value.as_object()?;
    let state = match object.get("state")?.as_str()? {
        "nothing" => ReleaseTrainGateState::Nothing,
        "unreleased" => ReleaseTrainGateState::Unreleased,
        "error" => ReleaseTrainGateState::Error,
        _ => return None,
    };
    for key in ["detail", "target", "range", "version"] {
        if !nullable_string(object.get(key)) {
            return None;
        }
    }
    Some(ReleaseTrainGateRecord {
        at: object.get("at")?.as_str()?.to_string(),
        state,
        detail: object
            .get("detail")
            .and_then(Value::as_str)
            .map(str::to_string),
        target: object
            .get("target")
            .and_then(Value::as_str)
            .map(str::to_string),
        range: object
            .get("range")
            .and_then(Value::as_str)
            .map(str::to_string),
        version: object
            .get("version")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn parse_release_peer(value: Option<&Value>) -> Option<ReleasePeer> {
    let object = value?.as_object()?;
    Some(ReleasePeer {
        command: object.get("command")?.as_str()?.to_string(),
        pid: object.get("pid")?.as_u64()? as u32,
        argv: string_list(object.get("argv"))?,
        started_at: object.get("startedAt")?.as_str()?.to_string(),
    })
}

fn parse_run_state(text: &str) -> Option<ReleaseTrainRunState> {
    Some(match text {
        "running" => ReleaseTrainRunState::Running,
        "released" => ReleaseTrainRunState::Released,
        "failed" => ReleaseTrainRunState::Failed,
        "nothing" => ReleaseTrainRunState::Nothing,
        "error" => ReleaseTrainRunState::Error,
        _ => return None,
    })
}

fn parse_run(value: &Value) -> Option<ReleaseTrainRun> {
    let object = value.as_object()?;
    if !nullable_string(object.get("endedAt"))
        || !nullable_string(object.get("version"))
        || !nullable_string(object.get("url"))
        || !nullable_string(object.get("detail"))
    {
        return None;
    }
    let commits = match object.get("commits") {
        None | Some(Value::Null) => None,
        Some(value) => {
            let count = value.as_i64()?;
            if count < 0 {
                return None;
            }
            Some(count)
        }
    };
    Some(ReleaseTrainRun {
        id: object.get("id")?.as_str()?.to_string(),
        started_at: object.get("startedAt")?.as_str()?.to_string(),
        ended_at: object
            .get("endedAt")
            .and_then(Value::as_str)
            .map(str::to_string),
        state: parse_run_state(object.get("state")?.as_str()?)?,
        range: object.get("range")?.as_str()?.to_string(),
        target: object.get("target")?.as_str()?.to_string(),
        version: object
            .get("version")
            .and_then(Value::as_str)
            .map(str::to_string),
        url: object
            .get("url")
            .and_then(Value::as_str)
            .map(str::to_string),
        detail: object
            .get("detail")
            .and_then(Value::as_str)
            .map(str::to_string),
        commits,
        peer: parse_release_peer(object.get("peer")),
    })
}

pub fn parse_state(text: &str) -> Option<ReleaseTrainState> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    let object = parsed.as_object()?;
    if object.get("version")?.as_i64()? != STATE_VERSION {
        return None;
    }
    if object.get("repo")?.as_str().is_none() || object.get("root")?.as_str().is_none() {
        return None;
    }
    let release = match object.get("release")? {
        Value::Null => None,
        value => Some(parse_release(value)?),
    };
    let failure = match object.get("failure")? {
        Value::Null => None,
        value => Some(parse_failure(value)?),
    };
    let gate = match object.get("gate")? {
        Value::Null => None,
        value => Some(parse_gate_record(value)?),
    };
    let runs: Vec<ReleaseTrainRun> = object
        .get("runs")?
        .as_array()?
        .iter()
        .map(parse_run)
        .collect::<Option<Vec<_>>>()?;
    let activity = string_list(object.get("activity"))?;
    let updated_at = object.get("updatedAt")?.as_str()?.to_string();
    Some(ReleaseTrainState {
        version: STATE_VERSION,
        repo: object.get("repo")?.as_str()?.to_string(),
        root: object.get("root")?.as_str()?.to_string(),
        release,
        failure,
        gate,
        runs: runs.into_iter().take(RUN_HISTORY_LIMIT).collect(),
        activity: activity
            .into_iter()
            .rev()
            .take(ACTIVITY_MAX_ENTRIES)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect(),
        updated_at,
    })
}

pub fn read_state(directory: &Path) -> Option<ReleaseTrainState> {
    std::fs::read_to_string(state_path(directory))
        .ok()
        .and_then(|text| parse_state(&text))
}

pub fn write_state(directory: &Path, state: &ReleaseTrainState) -> std::io::Result<()> {
    let value = serde_json::to_value(state)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    write_json_atomic(&state_path(directory), &value)
}

/// The non-merge commits one persisted run released, read from the request the
/// worker handed it. A run written before the shared state carried the count
/// still has this record.
pub fn read_run_commit_count(directory: &Path, id: &str) -> Option<i64> {
    let text = std::fs::read_to_string(request_path(directory, id)).ok()?;
    let parsed: Value = serde_json::from_str(&text).ok()?;
    let entries = parsed.get("releaseCommits")?.as_array()?;
    let count = entries.len() as i64;
    (count > 0).then_some(count)
}

/// Prepends one run and keeps the newest bounded history.
pub fn record_run(runs: &[ReleaseTrainRun], run: ReleaseTrainRun) -> Vec<ReleaseTrainRun> {
    let mut next: Vec<ReleaseTrainRun> = vec![run.clone()];
    next.extend(runs.iter().filter(|entry| entry.id != run.id).cloned());
    next.truncate(RUN_HISTORY_LIMIT);
    next
}

/// Trims the oldest entries and bytes of one activity list.
fn trim_activity(lines: &mut Vec<String>) {
    while lines.len() > ACTIVITY_MAX_ENTRIES {
        lines.remove(0);
    }
    let mut bytes: usize = lines.iter().map(|line| line.len()).sum();
    while bytes > ACTIVITY_MAX_BYTES && lines.len() > 1 {
        let removed = lines.remove(0);
        bytes = bytes.saturating_sub(removed.len());
    }
}

/// Appends one activity line, trimming the oldest entries and bytes.
pub fn append_activity(lines: &mut Vec<String>, text: &str) {
    lines.push(text.to_string());
    trim_activity(lines);
}

/// The newer of two timestamped records; an absent one loses, a tie keeps
/// `mine`.
fn newer<T: Clone>(mine: &Option<T>, disk: &Option<T>, at: impl Fn(&T) -> &str) -> Option<T> {
    let (Some(mine_value), Some(disk_value)) = (mine.as_ref(), disk.as_ref()) else {
        return mine.clone().or_else(|| disk.clone());
    };
    let mine_at = parse_iso_millis(at(mine_value));
    let disk_at = parse_iso_millis(at(disk_value));
    match (mine_at, disk_at) {
        (Some(mine_at), Some(disk_at)) if disk_at > mine_at => Some(disk_value.clone()),
        _ => Some(mine_value.clone()),
    }
}

/// The further-along of two records of one run.
///
/// A worker that read the shared state before another worker settled a run
/// still holds the `running` copy, and every earlier merge preferred the
/// writer's own copy — so the settled result disappeared from the shared
/// history and the page listed an older release as the newest. The settled
/// record now always wins whichever worker writes last; among two settled
/// records the later end wins, and a tie keeps this worker's view.
fn merge_run(mine: &ReleaseTrainRun, disk: &ReleaseTrainRun) -> ReleaseTrainRun {
    if mine.state.settled() != disk.state.settled() {
        return if mine.state.settled() {
            mine.clone()
        } else {
            disk.clone()
        };
    }
    if !mine.state.settled() {
        // Both are still running: keep the copy that names the agent peer, so
        // a pre-peer snapshot cannot erase the live run's detail.
        return if mine.peer.is_none() && disk.peer.is_some() {
            disk.clone()
        } else {
            mine.clone()
        };
    }
    let ended = |run: &ReleaseTrainRun| {
        run.ended_at
            .as_deref()
            .and_then(parse_iso_millis)
            .unwrap_or(0)
    };
    if ended(disk) > ended(mine) {
        disk.clone()
    } else {
        mine.clone()
    }
}

/// The union of this worker's shared state with what another live worker wrote
/// after this worker read its snapshot.
pub fn merge_state(
    mine: &ReleaseTrainState,
    disk: &ReleaseTrainState,
    appended: &[String],
) -> ReleaseTrainState {
    let mut runs: Vec<ReleaseTrainRun> = Vec::new();
    for run in disk.runs.iter().chain(mine.runs.iter()) {
        if let Some(existing) = runs.iter_mut().find(|entry| entry.id == run.id) {
            *existing = merge_run(run, existing);
        } else {
            runs.push(run.clone());
        }
    }
    runs.sort_by(|left, right| {
        let left_at = parse_iso_millis(&left.started_at).unwrap_or(0);
        let right_at = parse_iso_millis(&right.started_at).unwrap_or(0);
        right_at.cmp(&left_at).then_with(|| right.id.cmp(&left.id))
    });
    runs.truncate(RUN_HISTORY_LIMIT);
    let release = newer(&mine.release, &disk.release, |entry| &entry.at);
    let mut failure = newer(&mine.failure, &disk.failure, |entry| &entry.at);
    if let (Some(release), Some(failure_value)) = (&release, &failure) {
        let released_at = parse_iso_millis(&release.at);
        let failed_at = parse_iso_millis(&failure_value.at);
        if let (Some(released_at), Some(failed_at)) = (released_at, failed_at) {
            if released_at > failed_at {
                failure = None;
            }
        }
    }
    let mut activity: Vec<String> = disk.activity.clone();
    activity.extend(appended.iter().cloned());
    trim_activity(&mut activity);
    ReleaseTrainState {
        version: mine.version,
        repo: mine.repo.clone(),
        root: mine.root.clone(),
        release,
        failure,
        gate: newer(&mine.gate, &disk.gate, |entry| &entry.at),
        runs,
        activity,
        updated_at: mine.updated_at.clone(),
    }
}

/* ------------------------------------------------------------------------ */
/* Worker records                                                            */
/* ------------------------------------------------------------------------ */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentLifecycle {
    Stopped,
    Starting,
    Running,
    Stopping,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseTrainWorkerRecord {
    pub version: i64,
    pub pid: u32,
    pub started_at: String,
    pub root: String,
    pub state_dir: String,
    pub lifecycle: AgentLifecycle,
    pub enabled: bool,
    pub paused: bool,
    pub harness_version: Option<String>,
    pub argv: Vec<String>,
    pub last_run_at: Option<String>,
    pub next_run_at: Option<String>,
    pub last_error: Option<String>,
    pub notice: Option<String>,
    /// The run this worker is executing now, or null.
    pub active_run: Option<String>,
    pub updated_at: String,
}

fn parse_lifecycle(text: &str) -> Option<AgentLifecycle> {
    Some(match text {
        "stopped" => AgentLifecycle::Stopped,
        "starting" => AgentLifecycle::Starting,
        "running" => AgentLifecycle::Running,
        "stopping" => AgentLifecycle::Stopping,
        "failed" => AgentLifecycle::Failed,
        _ => return None,
    })
}

pub fn parse_worker_state(text: &str) -> Option<ReleaseTrainWorkerRecord> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    let object = parsed.as_object()?;
    if object.get("version")?.as_i64()? != WORKER_VERSION {
        return None;
    }
    let pid = object.get("pid")?.as_u64()?;
    if pid == 0 || pid > u32::MAX as u64 {
        return None;
    }
    if object.get("root")?.as_str().is_none() || object.get("stateDir")?.as_str().is_none() {
        return None;
    }
    if !nullable_string(object.get("harnessVersion"))
        || !nullable_string(object.get("lastRunAt"))
        || !nullable_string(object.get("nextRunAt"))
        || !nullable_string(object.get("lastError"))
        || !nullable_string(object.get("notice"))
        || !nullable_string(object.get("activeRun"))
    {
        return None;
    }
    Some(ReleaseTrainWorkerRecord {
        version: WORKER_VERSION,
        pid: pid as u32,
        started_at: object.get("startedAt")?.as_str()?.to_string(),
        root: object.get("root")?.as_str()?.to_string(),
        state_dir: object.get("stateDir")?.as_str()?.to_string(),
        lifecycle: parse_lifecycle(object.get("lifecycle")?.as_str()?)?,
        enabled: object.get("enabled")?.as_bool()?,
        paused: object.get("paused")?.as_bool()?,
        harness_version: object
            .get("harnessVersion")
            .and_then(Value::as_str)
            .map(str::to_string),
        argv: string_list(object.get("argv"))?,
        last_run_at: object
            .get("lastRunAt")
            .and_then(Value::as_str)
            .map(str::to_string),
        next_run_at: object
            .get("nextRunAt")
            .and_then(Value::as_str)
            .map(str::to_string),
        last_error: object
            .get("lastError")
            .and_then(Value::as_str)
            .map(str::to_string),
        notice: object
            .get("notice")
            .and_then(Value::as_str)
            .map(str::to_string),
        active_run: object
            .get("activeRun")
            .and_then(Value::as_str)
            .map(str::to_string),
        updated_at: object.get("updatedAt")?.as_str()?.to_string(),
    })
}

pub fn read_worker_state(path: &Path) -> Option<ReleaseTrainWorkerRecord> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| parse_worker_state(&text))
}

pub fn write_worker_state(path: &Path, state: &ReleaseTrainWorkerRecord) -> std::io::Result<()> {
    let value = serde_json::to_value(state)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    write_json_atomic(path, &value)
}

/* ------------------------------------------------------------------------ */
/* Locks                                                                     */
/* ------------------------------------------------------------------------ */

/// One live worker's lock record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockOwner {
    pub pid: u32,
    /// ISO 8601 start time of the owning process, from its own clock.
    pub started_at: String,
    pub repo: String,
    pub state_dir: String,
    pub harness_version: Option<String>,
    pub argv: Vec<String>,
}

impl LockOwner {
    fn to_json(&self) -> Value {
        json!({
            "pid": self.pid,
            "startedAt": self.started_at,
            "repo": self.repo,
            "stateDir": self.state_dir,
            "harnessVersion": self.harness_version,
            "argv": self.argv,
        })
    }
}

/// The details this process records in the lock it writes.
#[derive(Debug, Clone)]
pub struct LockDetails {
    pub repo: String,
    pub state_dir: String,
    pub harness_version: Option<String>,
    pub argv: Vec<String>,
}

impl LockDetails {
    pub fn for_worker(repo_dir: &Path, state_dir: &Path, version: Option<&str>) -> Self {
        Self {
            repo: repo_dir.to_string_lossy().into_owned(),
            state_dir: state_dir.to_string_lossy().into_owned(),
            harness_version: version.map(str::to_string),
            argv: std::env::args().collect(),
        }
    }
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

/// The instant a live process started, from `/proc/<pid>/stat` and uptime.
fn process_started_at(pid: u32) -> Option<i64> {
    crate::supervision::process_age_ms(pid).map(|age| now_millis() - age as i64)
}

fn own_started_at() -> String {
    let started = process_started_at(std::process::id()).unwrap_or_else(now_millis);
    iso_from_millis(started)
}

fn owner_alive(owner: &LockOwner) -> bool {
    if !pid_alive(owner.pid) {
        return false;
    }
    let Some(recorded) = parse_iso_millis(&owner.started_at) else {
        return false;
    };
    match process_started_at(owner.pid) {
        Some(actual) => (actual - recorded).abs() <= 2_000,
        None => cfg!(not(target_os = "linux")),
    }
}

fn parse_lock(text: &str) -> Option<LockOwner> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    let object = parsed.as_object()?;
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
    crate::sampling::text(path).and_then(|text| parse_lock(&text))
}

/// The live owner of a lock, or none when it is missing or stale.
pub fn live_lock_owner(path: &Path) -> Option<LockOwner> {
    read_lock(path).filter(owner_alive)
}

/// Every live owner beside one lock path: the legacy lock and each version.
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
                .flatten()
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

/// One held lock; dropping it releases the file it created.
#[derive(Debug)]
pub struct AcquiredLock {
    path: PathBuf,
    token: String,
}

impl AcquiredLock {
    /// Removes the lock file when it is still this acquisition's.
    pub fn release(self) {
        release_lock(&self.path, &self.token);
    }
}

impl Drop for AcquiredLock {
    fn drop(&mut self) {
        release_lock(&self.path, &self.token);
    }
}

/// The outcome of one acquisition.
#[derive(Debug)]
pub enum LockAcquisition {
    Acquired(AcquiredLock),
    Taken { owner: Option<LockOwner> },
}

fn read_lock_token(path: &Path) -> Option<String> {
    let text = crate::sampling::text(path)?;
    let parsed: Value = serde_json::from_str(&text).ok()?;
    parsed.get("token")?.as_str().map(str::to_string)
}

/// Takes the lock, or reports the live owner. A lock whose owner is gone or
/// whose pid was recycled is reclaimed once.
pub fn acquire_lock(path: &Path, details: &LockDetails) -> LockAcquisition {
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
        let mut staged = path.as_os_str().to_os_string();
        staged.push(format!(
            ".new-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let staged = PathBuf::from(staged);
        let mut document = owner.to_json();
        if let Some(object) = document.as_object_mut() {
            object.insert("token".into(), Value::String(token.clone()));
        }
        let result = (|| -> std::io::Result<()> {
            use std::io::Write as _;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staged)?;
            file.write_all(format!("{}\n", crate::jsjson::stringify(&document)).as_bytes())?;
            std::fs::hard_link(&staged, path)
        })();
        let _ = std::fs::remove_file(&staged);
        match result {
            Ok(()) => {
                return LockAcquisition::Acquired(AcquiredLock {
                    path: path.into(),
                    token,
                })
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let Some(existing) = read_lock(path) else {
                    continue;
                };
                if owner_alive(&existing) {
                    return LockAcquisition::Taken {
                        owner: Some(existing),
                    };
                }
                reclaim_stale_lock(path);
            }
            Err(_) => return LockAcquisition::Taken { owner: None },
        }
    }
    LockAcquisition::Taken { owner: None }
}

/// Moves an inspected stale lock aside, restoring a newer lock that arrived.
fn reclaim_stale_lock(path: &Path) {
    let mut aside = path.as_os_str().to_os_string();
    aside.push(format!(
        ".reclaim-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let aside = PathBuf::from(aside);
    let inspected_token = read_lock_token(path);
    let inspected = read_lock(path);
    if std::fs::rename(path, &aside).is_err() {
        return;
    }
    let moved_token = read_lock_token(&aside);
    let same = match (&inspected_token, &moved_token) {
        (Some(left), Some(right)) => left == right,
        (None, None) => inspected.is_some() && read_lock(&aside).is_some(),
        _ => false,
    };
    if !same {
        let _ = std::fs::hard_link(&aside, path);
        let _ = std::fs::remove_file(&aside);
        return;
    }
    let _ = std::fs::remove_file(&aside);
}

fn release_lock(path: &Path, token: &str) {
    if let Some(current) = read_lock_token(path) {
        if current != token {
            return;
        }
    }
    let _ = std::fs::remove_file(path);
}

/* ------------------------------------------------------------------------ */
/* Control files                                                             */
/* ------------------------------------------------------------------------ */

/// The dashboard-to-worker channel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReleaseTrainCommand {
    Stop,
    Drain,
    Pause,
    Resume,
    Check,
    Settings {
        interval_minutes: i64,
        max_per_hour: Option<i64>,
        max_pending: Option<i64>,
    },
}

impl ReleaseTrainCommand {
    pub fn to_json(&self) -> Value {
        match self {
            ReleaseTrainCommand::Stop => json!({"type": "stop"}),
            ReleaseTrainCommand::Drain => json!({"type": "drain"}),
            ReleaseTrainCommand::Pause => json!({"type": "pause"}),
            ReleaseTrainCommand::Resume => json!({"type": "resume"}),
            ReleaseTrainCommand::Check => json!({"type": "check"}),
            ReleaseTrainCommand::Settings {
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

static COMMAND_SEQUENCE: AtomicI64 = AtomicI64::new(0);

/// Writes one command atomically, named so the names sort in submission order.
pub fn write_command(directory: &Path, command: &ReleaseTrainCommand) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(directory)?;
    let sequence = COMMAND_SEQUENCE.fetch_add(1, Ordering::SeqCst) + 1;
    let name = format!("{:014}-{:06}.json", now_millis(), sequence);
    let path = directory.join(&name);
    let mut temporary = path.as_os_str().to_os_string();
    temporary.push(format!(".{}.tmp", std::process::id()));
    let temporary = PathBuf::from(temporary);
    std::fs::write(
        &temporary,
        format!("{}\n", crate::jsjson::stringify(&command.to_json())),
    )?;
    std::fs::rename(&temporary, &path)?;
    Ok(path)
}

pub fn parse_command(text: &str) -> Option<ReleaseTrainCommand> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    let object = parsed.as_object()?;
    Some(match object.get("type")?.as_str()? {
        "stop" => ReleaseTrainCommand::Stop,
        "drain" => ReleaseTrainCommand::Drain,
        "pause" => ReleaseTrainCommand::Pause,
        "resume" => ReleaseTrainCommand::Resume,
        "check" => ReleaseTrainCommand::Check,
        "settings" => {
            let interval = object.get("intervalMinutes")?;
            let per_hour = object.get("maxPerHour")?;
            let pending = object.get("maxPending")?;
            if !is_valid_cadence(interval) || !is_valid_limit(per_hour) || !is_valid_limit(pending)
            {
                return None;
            }
            ReleaseTrainCommand::Settings {
                interval_minutes: interval.as_i64()?,
                max_per_hour: per_hour.as_i64(),
                max_pending: pending.as_i64(),
            }
        }
        _ => return None,
    })
}

/// Takes every queued command in submission order.
pub fn take_commands(directory: &Path) -> Vec<ReleaseTrainCommand> {
    let mut names: Vec<String> = match std::fs::read_dir(directory) {
        Ok(entries) => entries
            .flatten()
            .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
            .filter(|name| name.ends_with(".json"))
            .collect(),
        Err(_) => return Vec::new(),
    };
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
/* The gate                                                                  */
/* ------------------------------------------------------------------------ */

/// One commit as the gate reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseTrainCommit {
    pub sha: String,
    pub subject: String,
    pub merge: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseTrainTag {
    pub tag: String,
    pub version: String,
}

/// One deterministic answer for the tracked branch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReleaseTrainGate {
    Unreleased {
        target: String,
        previous: Option<ReleaseTrainTag>,
        range: String,
        version: String,
        commits: Vec<ReleaseTrainCommit>,
        release_commits: Vec<ReleaseTrainCommit>,
    },
    Nothing {
        target: String,
        previous: Option<ReleaseTrainTag>,
        range: String,
    },
    Error {
        detail: String,
    },
}

impl ReleaseTrainGate {
    pub fn state(&self) -> ReleaseTrainGateState {
        match self {
            ReleaseTrainGate::Unreleased { .. } => ReleaseTrainGateState::Unreleased,
            ReleaseTrainGate::Nothing { .. } => ReleaseTrainGateState::Nothing,
            ReleaseTrainGate::Error { .. } => ReleaseTrainGateState::Error,
        }
    }

    /// The document `--check --json` prints.
    pub fn to_json(&self) -> Value {
        match self {
            ReleaseTrainGate::Unreleased {
                target,
                previous,
                range,
                version,
                commits,
                release_commits,
            } => json!({
                "state": "unreleased",
                "target": target,
                "previous": previous.as_ref().map(|tag| json!({"tag": tag.tag, "version": tag.version})),
                "range": range,
                "version": version,
                "commits": commits,
                "releaseCommits": release_commits,
            }),
            ReleaseTrainGate::Nothing {
                target,
                previous,
                range,
            } => json!({
                "state": "nothing",
                "target": target,
                "previous": previous.as_ref().map(|tag| json!({"tag": tag.tag, "version": tag.version})),
                "range": range,
            }),
            ReleaseTrainGate::Error { detail } => json!({
                "state": "error",
                "detail": detail,
            }),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitOutcome {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl GitOutcome {
    pub fn ok(stdout: String) -> Self {
        Self {
            code: 0,
            stdout,
            stderr: String::new(),
        }
    }
}

pub type GateGit = Arc<dyn Fn(&[&str]) -> GitOutcome + Send + Sync>;

#[derive(Clone)]
pub struct ReleaseTrainGateOptions {
    pub remote: String,
    pub branch: String,
    pub fetch: bool,
    /// The Gitea HTTP credential a fetch of an SSH origin needs. It is
    /// presented only when the anonymous attempt cannot read the refs.
    pub credential: Option<GiteaGitCredential>,
    pub run: Option<GateGit>,
    /// The runner for the retry that presents `credential`. A caller that
    /// injects `run` must inject this one too to exercise the retry.
    pub run_with_credential: Option<GateGit>,
}

impl Default for ReleaseTrainGateOptions {
    fn default() -> Self {
        Self {
            remote: "origin".to_string(),
            branch: "main".to_string(),
            fetch: true,
            credential: None,
            run: None,
            run_with_credential: None,
        }
    }
}

/// One `git -C <repoDir>` command run with the given environment overrides.
fn gate_git_runner(repo_dir: &Path, environment: Vec<(String, String)>) -> GateGit {
    let repo_dir = repo_dir.to_path_buf();
    Arc::new(move |args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&repo_dir)
            .envs(environment.iter().map(|(key, value)| (key, value)))
            .args(args)
            .output();
        match output {
            Ok(output) => GitOutcome {
                code: output.status.code().unwrap_or(1),
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            },
            Err(error) => GitOutcome {
                code: 1,
                stdout: String::new(),
                stderr: error.to_string(),
            },
        }
    })
}

/// The default runner: one `git -C <repoDir>` invocation that presents the
/// configured credential.
pub fn release_train_git(repo_dir: &Path, credential: Option<&GiteaGitCredential>) -> GateGit {
    gate_git_runner(repo_dir, gitea_git_environment(credential))
}

/// The default anonymous runner: the same invocation without the token.
pub fn release_train_git_anonymous(
    repo_dir: &Path,
    credential: Option<&GiteaGitCredential>,
) -> GateGit {
    gate_git_runner(repo_dir, gitea_git_anonymous_environment(credential))
}

/// The fetch outcome: the anonymous attempt, retried once with the credential
/// when the repository could not be read without it.
fn gate_fetch(run: &GateGit, run_with_credential: Option<&GateGit>, args: &[&str]) -> GitOutcome {
    let fetched = run(args);
    match run_with_credential {
        Some(run) if fetched.code != 0 => run(args),
        _ => fetched,
    }
}

fn first_line(text: &str) -> String {
    text.split('\n')
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("no diagnostic")
        .to_string()
}

fn gate_failure(description: &str, outcome: &GitOutcome) -> ReleaseTrainGate {
    let detail = if outcome.stderr.trim().is_empty() {
        outcome.stdout.as_str()
    } else {
        outcome.stderr.as_str()
    };
    ReleaseTrainGate::Error {
        detail: format!("{description}: {}", first_line(detail)),
    }
}

fn release_tag_regex() -> &'static regex::Regex {
    static PATTERN: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"^v(\d+\.\d+\.\d+)$").expect("a release tag pattern"));
    &PATTERN
}

// Refusals carry the gate's full explanation so callers can surface it as-is;
// boxing a cold failure path would only add indirection.
#[allow(clippy::result_large_err)]
fn merged_tags(run: &GateGit, target: &str) -> Result<Vec<ReleaseTrainTag>, ReleaseTrainGate> {
    let result = run(&["tag", "--merged", target, "--list", "v*"]);
    if result.code != 0 {
        return Err(gate_failure(
            &format!("could not read the release tags merged into {target}"),
            &result,
        ));
    }
    let mut tags = Vec::new();
    for line in result.stdout.split('\n') {
        let line = line.trim();
        if let Some(captures) = release_tag_regex().captures(line) {
            let version = captures.get(1).map(|entry| entry.as_str()).unwrap_or("");
            if !version.is_empty() {
                tags.push(ReleaseTrainTag {
                    tag: format!("v{version}"),
                    version: version.to_string(),
                });
            }
        }
    }
    Ok(tags)
}

/// One deterministic answer for the tracked branch: release, nothing, or
/// failure.
pub fn check_release_train(repo_dir: &Path, options: ReleaseTrainGateOptions) -> ReleaseTrainGate {
    let injected = options.run.is_some();
    let credential = options.credential.as_ref();
    let run = options
        .run
        .unwrap_or_else(|| release_train_git_anonymous(repo_dir, credential));
    // Only the default path builds the credential attempt from the configured
    // credential: an injected runner pair stays exactly what the caller gave.
    let run_with_credential = match options.run_with_credential {
        Some(run) => Some(run),
        None if injected => None,
        None => credential.map(|credential| release_train_git(repo_dir, Some(credential))),
    };
    let target_ref = format!("refs/remotes/{}/{}", options.remote, options.branch);
    if options.fetch {
        let fetch_ref = format!("+refs/heads/{}:{}", options.branch, target_ref);
        let fetched = gate_fetch(
            &run,
            run_with_credential.as_ref(),
            &[
                "fetch",
                "--prune",
                &options.remote,
                &fetch_ref,
                "+refs/tags/*:refs/tags/*",
            ],
        );
        if fetched.code != 0 {
            return gate_failure(
                &format!(
                    "could not fetch {}/{} and its tags",
                    options.remote, options.branch
                ),
                &fetched,
            );
        }
    }
    let resolved = run(&["rev-parse", "--verify", &format!("{target_ref}^{{commit}}")]);
    if resolved.code != 0 {
        return gate_failure(
            &format!("could not read {}/{}", options.remote, options.branch),
            &resolved,
        );
    }
    let target = resolved.stdout.trim().to_string();
    if target.is_empty() {
        return ReleaseTrainGate::Error {
            detail: format!(
                "could not read {}/{}: it resolved to no commit",
                options.remote, options.branch
            ),
        };
    }
    let tags = match merged_tags(&run, &target) {
        Ok(tags) => tags,
        Err(failure) => return failure,
    };
    let newest = highest_release_version(tags.iter().map(|tag| tag.version.as_str()));
    let previous =
        newest.and_then(|version| tags.iter().find(|tag| tag.version == version).cloned());
    let range = match &previous {
        Some(tag) => format!("{}..{target}", tag.tag),
        None => target.clone(),
    };
    let commits = match read_commits(repo_dir, &range) {
        Ok(commits) => commits,
        Err(detail) => return ReleaseTrainGate::Error { detail },
    };
    let release_commits: Vec<CommitRecord> = commits
        .iter()
        .filter(|commit| !is_merge_commit(commit))
        .cloned()
        .collect();
    if release_commits.is_empty() {
        return ReleaseTrainGate::Nothing {
            target,
            previous,
            range,
        };
    }
    let version = match next_release_version(
        previous.as_ref().map(|tag| tag.version.as_str()),
        release_level(&commits),
    ) {
        Ok(version) => version,
        Err(detail) => return ReleaseTrainGate::Error { detail },
    };
    ReleaseTrainGate::Unreleased {
        target,
        previous,
        range,
        version,
        commits: commits.iter().map(describe_commit).collect(),
        release_commits: release_commits.iter().map(describe_commit).collect(),
    }
}

fn describe_commit(commit: &CommitRecord) -> ReleaseTrainCommit {
    ReleaseTrainCommit {
        sha: commit.sha.clone(),
        subject: commit.subject.clone(),
        merge: is_merge_commit(commit),
    }
}

/* ------------------------------------------------------------------------ */
/* Commits and release versions                                              */
/* ------------------------------------------------------------------------ */

const BASELINE_VERSION: &str = "1.0.0";
const RECORD_SEPARATOR: char = '\u{1e}';
const FIELD_SEPARATOR: char = '\u{1f}';

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitRecord {
    pub sha: String,
    pub subject: String,
    pub body: String,
    pub parents: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReleaseLevel {
    Major,
    Minor,
    Patch,
}

fn subject_regex() -> &'static regex::Regex {
    static PATTERN: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^([A-Za-z]+)(?:\(([^)]*)\))?(!)?: ([\s\S]*)$")
            .expect("a conventional subject pattern")
    });
    &PATTERN
}

fn breaking_regex() -> &'static regex::Regex {
    static PATTERN: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?m)^BREAKING[ -]CHANGE:").expect("a breaking footer pattern")
    });
    &PATTERN
}

/// True for a merge commit. Git records two parents for a real merge; a
/// synthetic merge keeps only one parent, so Git's generated `Merge …` subject
/// is recognized too.
pub fn is_merge_commit(commit: &CommitRecord) -> bool {
    commit.parents.len() >= 2 || commit.subject.starts_with("Merge ")
}

/// The bump one commit contributes; none for a merge commit.
pub fn commit_level(commit: &CommitRecord) -> Option<ReleaseLevel> {
    if is_merge_commit(commit) {
        return None;
    }
    let captures = subject_regex().captures(&commit.subject);
    let breaking = captures
        .as_ref()
        .and_then(|captures| captures.get(3))
        .is_some();
    let kind = captures
        .as_ref()
        .and_then(|captures| captures.get(1))
        .map(|entry| entry.as_str())
        .unwrap_or("");
    if breaking || breaking_regex().is_match(&commit.body) {
        return Some(ReleaseLevel::Major);
    }
    if kind == "feat" {
        Some(ReleaseLevel::Minor)
    } else {
        Some(ReleaseLevel::Patch)
    }
}

/// The highest bump among the commits; none when there is no non-merge commit.
pub fn release_level(commits: &[CommitRecord]) -> Option<ReleaseLevel> {
    let mut level: Option<ReleaseLevel> = None;
    for commit in commits {
        match commit_level(commit) {
            Some(ReleaseLevel::Major) => return Some(ReleaseLevel::Major),
            Some(ReleaseLevel::Minor) => level = Some(ReleaseLevel::Minor),
            Some(ReleaseLevel::Patch) if level.is_none() => level = Some(ReleaseLevel::Patch),
            _ => {}
        }
    }
    level
}

fn parse_version(value: &str) -> Option<[i64; 3]> {
    let parts: Vec<&str> = value.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let mut parsed = [0i64; 3];
    for (index, part) in parts.iter().enumerate() {
        if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        parsed[index] = part.parse().ok()?;
    }
    Some(parsed)
}

pub fn compare_release_versions(left: &str, right: &str) -> Option<i32> {
    let left = parse_version(left)?;
    let right = parse_version(right)?;
    for index in 0..3 {
        if left[index] != right[index] {
            return Some(if left[index] > right[index] { 1 } else { -1 });
        }
    }
    Some(0)
}

/// The highest release version among published tags; malformed tags are
/// ignored.
pub fn highest_release_version<'a>(versions: impl Iterator<Item = &'a str>) -> Option<String> {
    let mut highest: Option<String> = None;
    for version in versions {
        if parse_version(version).is_none() {
            continue;
        }
        if highest
            .as_deref()
            .map(|current| compare_release_versions(version, current).unwrap_or(0) > 0)
            .unwrap_or(true)
        {
            highest = Some(version.to_string());
        }
    }
    highest
}

/// The earliest release version among tags that contain a commit; malformed
/// tags are ignored.
pub fn lowest_release_version<'a>(versions: impl Iterator<Item = &'a str>) -> Option<String> {
    let mut lowest: Option<String> = None;
    for version in versions {
        if parse_version(version).is_none() {
            continue;
        }
        if lowest
            .as_deref()
            .map(|current| compare_release_versions(version, current).unwrap_or(0) < 0)
            .unwrap_or(true)
        {
            lowest = Some(version.to_string());
        }
    }
    lowest
}

/// The next release version: the 1.0.0 baseline first, then the bump.
pub fn next_release_version(
    previous: Option<&str>,
    level: Option<ReleaseLevel>,
) -> Result<String, String> {
    let Some(previous) = previous else {
        return Ok(BASELINE_VERSION.to_string());
    };
    let parsed =
        parse_version(previous).ok_or_else(|| format!("unreadable release version: {previous}"))?;
    let order = compare_release_versions(previous, BASELINE_VERSION)
        .ok_or_else(|| format!("unreadable release version: {previous}"))?;
    if order < 0 {
        return Ok(BASELINE_VERSION.to_string());
    }
    match level {
        None => Ok(previous.to_string()),
        Some(ReleaseLevel::Major) => Ok(format!("{}.0.0", parsed[0] + 1)),
        Some(ReleaseLevel::Minor) => Ok(format!("{}.{}.0", parsed[0], parsed[1] + 1)),
        Some(ReleaseLevel::Patch) => Ok(format!("{}.{}.{}", parsed[0], parsed[1], parsed[2] + 1)),
    }
}

fn parse_commit_records(text: &str) -> Vec<CommitRecord> {
    let mut records = Vec::new();
    for chunk in text.split(RECORD_SEPARATOR) {
        let record = chunk.trim_start_matches('\n');
        if record.trim().is_empty() {
            continue;
        }
        let fields: Vec<&str> = record.split(FIELD_SEPARATOR).collect();
        let sha = fields.first().copied().unwrap_or("");
        let parents = fields.get(1).copied().unwrap_or("");
        let subject = fields.get(2).copied().unwrap_or("");
        let body = fields.get(3).copied().unwrap_or("");
        records.push(CommitRecord {
            sha: sha.to_string(),
            subject: subject.to_string(),
            body: body.to_string(),
            parents: parents
                .split_whitespace()
                .filter(|parent| !parent.is_empty())
                .map(str::to_string)
                .collect(),
        });
    }
    records
}

/// Every commit reachable from `range`, merges included.
pub fn read_commits(repo_dir: &Path, range: &str) -> Result<Vec<CommitRecord>, String> {
    let format = "%H\u{1f}%P\u{1f}%s\u{1f}%b\u{1e}";
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo_dir)
        .arg("log")
        .arg(format!("--format={format}"))
        .arg(range)
        .arg("--")
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let reason = if stderr.is_empty() {
            format!("exit {}", output.status.code().unwrap_or(1))
        } else {
            stderr
        };
        return Err(format!("could not read the commits of {range}: {reason}"));
    }
    Ok(parse_commit_records(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

fn git_stdout(repo_dir: &Path, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo_dir)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// The release tags reachable from `head`, with their `v` stripped.
pub fn release_tags(repo_dir: &Path, head: &str) -> Vec<ReleaseTrainTag> {
    let Some(stdout) = git_stdout(repo_dir, &["tag", "--merged", head, "--list", "v*"]) else {
        return Vec::new();
    };
    let mut tags = Vec::new();
    for line in stdout.split('\n') {
        let line = line.trim();
        if let Some(captures) = release_tag_regex().captures(line) {
            let version = captures.get(1).map(|entry| entry.as_str()).unwrap_or("");
            if !version.is_empty() {
                tags.push(ReleaseTrainTag {
                    tag: format!("v{version}"),
                    version: version.to_string(),
                });
            }
        }
    }
    tags
}

/// The highest release version whose tag points exactly at `sha`.
pub fn release_version_at(repo_dir: &Path, sha: &str) -> Option<String> {
    let stdout = git_stdout(repo_dir, &["tag", "--points-at", sha, "--list", "v*"])?;
    let versions: Vec<&str> = stdout
        .split('\n')
        .filter_map(|line| {
            let line = line.trim();
            release_tag_regex()
                .captures(line)
                .and_then(|captures| captures.get(1))
                .map(|entry| entry.as_str())
        })
        .collect();
    highest_release_version(versions.into_iter())
}

/* ------------------------------------------------------------------------ */
/* Release verification                                                      */
/* ------------------------------------------------------------------------ */

/// The part of a release the verification read, for a failure that names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReleaseVerificationPhase {
    Tag,
    Github,
    Gitea,
}

impl ReleaseVerificationPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            ReleaseVerificationPhase::Tag => "tag",
            ReleaseVerificationPhase::Github => "github",
            ReleaseVerificationPhase::Gitea => "gitea",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReleaseVerification {
    Ok {
        version: String,
        url: String,
    },
    Failed {
        phase: ReleaseVerificationPhase,
        version: String,
        detail: String,
    },
}

/// One Gitea release as the verification reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForgeRelease {
    pub asset_names: Vec<String>,
    pub url: String,
}

pub type RefreshFn = Arc<dyn Fn(&Path) -> GitOutcome + Send + Sync>;
pub type ReadGithubAssetsFn = Arc<
    dyn Fn(String) -> Pin<Box<dyn Future<Output = Result<Option<Vec<String>>, String>> + Send>>
        + Send
        + Sync,
>;
pub type ReadReleaseFn = Arc<
    dyn Fn(String) -> Pin<Box<dyn Future<Output = Result<Option<ForgeRelease>, String>> + Send>>
        + Send
        + Sync,
>;

/// How often and how patiently one verification read retries a failed read.
///
/// A release's verdict must not turn on a single dropped request, so a read
/// that fails is retried inside this budget before it is reported. A release
/// the forge answers as absent is not a failure and is never retried.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReadRetry {
    pub attempts: usize,
    pub delay: Duration,
}

impl Default for ReadRetry {
    fn default() -> Self {
        Self {
            attempts: 6,
            delay: Duration::from_secs(5),
        }
    }
}

#[derive(Clone)]
pub struct ReleaseVerificationOptions {
    pub repo_dir: PathBuf,
    /// The commit the run released.
    pub target: String,
    /// The version the gate asked this run to release.
    pub version: String,
    pub environment: HashMap<String, String>,
    pub activity: ActivityFn,
    /// Refreshes the checkout's tags; the default fetches the origin's.
    pub refresh: Option<RefreshFn>,
    /// Reads one GitHub release's asset names; the default asks GitHub.
    pub read_github_assets: Option<ReadGithubAssetsFn>,
    /// Reads one Gitea release and its page URL.
    pub read_release: Option<ReadReleaseFn>,
    /// Retries one read that failed in transport; the default tolerates a
    /// short outage.
    pub read_retry: Option<ReadRetry>,
}

/// Runs one remote read, retrying a failure inside the policy's budget.
async fn read_with_retries<T>(
    retry: ReadRetry,
    mut read: impl FnMut() -> Pin<Box<dyn Future<Output = Result<T, String>> + Send>>,
) -> Result<T, String> {
    let attempts = retry.attempts.max(1);
    let mut last = String::new();
    for attempt in 0..attempts {
        if attempt > 0 && !retry.delay.is_zero() {
            tokio::time::sleep(retry.delay).await;
        }
        match read().await {
            Ok(value) => return Ok(value),
            Err(error) => last = error,
        }
    }
    Err(last)
}

fn short_sha(sha: &str) -> String {
    sha.chars().take(7).collect()
}

/// Verifies the release the train expects, from Git, npm, and Gitea.
pub async fn verify_shipped(options: ReleaseVerificationOptions) -> ReleaseVerification {
    let version_failed = |phase: ReleaseVerificationPhase, version: &str, detail: String| {
        ReleaseVerification::Failed {
            phase,
            version: version.to_string(),
            detail,
        }
    };
    let refresh: RefreshFn = options.refresh.clone().unwrap_or_else(|| {
        let environment = options.environment.clone();
        Arc::new(move |repo_dir: &Path| {
            let credential = gitea_git_credential(repo_dir, &environment);
            let overrides = gitea_git_environment(credential.as_ref());
            let output = std::process::Command::new("git")
                .arg("-C")
                .arg(repo_dir)
                .envs(overrides.iter().map(|(key, value)| (key, value)))
                .args(["fetch", "--quiet", "--tags", "origin"])
                .output();
            match output {
                Ok(output) => GitOutcome {
                    code: output.status.code().unwrap_or(1),
                    stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
                    stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
                },
                Err(error) => GitOutcome {
                    code: 1,
                    stdout: String::new(),
                    stderr: error.to_string(),
                },
            }
        })
    });
    let fetched = refresh(&options.repo_dir);
    if fetched.code != 0 {
        let diagnostic = if fetched.stderr.is_empty() {
            fetched.stdout.as_str()
        } else {
            fetched.stderr.as_str()
        };
        return version_failed(
            ReleaseVerificationPhase::Tag,
            &options.version,
            format!(
                "tag binding: could not refresh the release tags for v{}: {}",
                options.version,
                first_line(diagnostic)
            ),
        );
    }
    let contains = std::process::Command::new("git")
        .arg("-C")
        .arg(&options.repo_dir)
        .args(["tag", "--contains", &options.target, "--list", "v*"])
        .output();
    let contains = match contains {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).into_owned()
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            let diagnostic = if stderr.trim().is_empty() {
                stdout.as_ref()
            } else {
                stderr.as_ref()
            };
            return version_failed(
                ReleaseVerificationPhase::Tag,
                &options.version,
                format!(
                    "tag binding: could not read the tags containing {} for v{}: {}",
                    short_sha(&options.target),
                    options.version,
                    first_line(diagnostic)
                ),
            );
        }
        Err(error) => {
            return version_failed(
                ReleaseVerificationPhase::Tag,
                &options.version,
                format!(
                    "tag binding: could not read the tags containing {} for v{}: {}",
                    short_sha(&options.target),
                    options.version,
                    first_line(&error.to_string())
                ),
            )
        }
    };
    let versions: Vec<&str> = contains
        .split('\n')
        .filter_map(|line| {
            let line = line.trim();
            release_tag_regex()
                .captures(line)
                .and_then(|captures| captures.get(1))
                .map(|entry| entry.as_str())
        })
        .collect();
    let version = release_version_at(&options.repo_dir, &options.target)
        .or_else(|| lowest_release_version(versions.into_iter()));
    let Some(version) = version else {
        return version_failed(
            ReleaseVerificationPhase::Tag,
            &options.version,
            format!(
                "tag binding: no release tag names or contains {} for v{}",
                short_sha(&options.target),
                options.version
            ),
        );
    };
    let tag = format!("v{version}");
    (options.activity)(&format!(
        "verified {tag} names or contains {}",
        short_sha(&options.target)
    ));

    let read_github_assets: ReadGithubAssetsFn =
        options.read_github_assets.clone().unwrap_or_else(|| {
            let environment = options.environment.clone();
            default_github_assets_reader(environment)
        });
    let retry = options.read_retry.unwrap_or_default();
    let github_assets = match read_with_retries(retry, || read_github_assets(tag.clone())).await {
        Ok(Some(assets)) => assets,
        Ok(None) => {
            return version_failed(
                ReleaseVerificationPhase::Github,
                &version,
                format!("GitHub assets: the release {tag} does not exist"),
            )
        }
        Err(error) => {
            return version_failed(
                ReleaseVerificationPhase::Github,
                &version,
                format!("GitHub assets: the release {tag} could not be read: {error}"),
            )
        }
    };
    let mut expected: Vec<String> = RELEASE_TARGETS
        .iter()
        .map(|target| format!("devboard-{target}.tar.xz"))
        .collect();
    expected.extend(RELEASE_INSTALLERS.iter().map(|name| name.to_string()));
    for asset in &expected {
        if !github_assets.contains(asset) {
            return version_failed(
                ReleaseVerificationPhase::Github,
                &version,
                format!("GitHub assets: the release {tag} is missing {asset}"),
            );
        }
    }
    (options.activity)(&format!(
        "verified {} GitHub asset(s) for {tag}",
        expected.len()
    ));

    let read_release: ReadReleaseFn = match options.read_release.clone() {
        Some(reader) => reader,
        None => {
            let repo_dir = options.repo_dir.clone();
            let environment = options.environment.clone();
            default_release_reader(repo_dir, environment)
        }
    };
    let release = read_with_retries(retry, || read_release(tag.clone())).await;
    let release = match release {
        Ok(Some(release)) => release,
        Ok(None) => {
            return version_failed(
                ReleaseVerificationPhase::Gitea,
                &version,
                format!("Gitea manifest: the release {tag} does not exist"),
            )
        }
        Err(error) => {
            return version_failed(
                ReleaseVerificationPhase::Gitea,
                &version,
                format!("Gitea manifest: the release {tag} could not be read: {error}"),
            )
        }
    };
    for asset in [MANIFEST_ASSET, MANIFEST_CHECKSUM_ASSET] {
        if !release.asset_names.iter().any(|name| name == asset) {
            return version_failed(
                ReleaseVerificationPhase::Gitea,
                &version,
                format!("Gitea manifest: the release {tag} is missing {asset}"),
            );
        }
    }
    (options.activity)(&format!(
        "verified {MANIFEST_ASSET} and its checksum on Gitea for {tag}"
    ));
    ReleaseVerification::Ok {
        version,
        url: release.url,
    }
}

fn env_value(environment: &HashMap<String, String>, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = environment.get(*key) {
            let trimmed = value.trim().trim_end_matches('/');
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// Reads one GitHub release's asset names.
///
/// GitHub answers `404` for a private release repository read without a
/// token, so the reader resolves the same credential `publish` dispatches
/// with. A missing release is `None`; any other refusal is an error naming
/// the phase.
fn default_github_assets_reader(environment: HashMap<String, String>) -> ReadGithubAssetsFn {
    Arc::new(move |tag: String| {
        let environment = environment.clone();
        Box::pin(async move {
            let token = crate::release::github_api_token(&environment).await;
            let encoded: String = url::form_urlencoded::byte_serialize(tag.as_bytes()).collect();
            let url = format!(
                "https://api.github.com/repos/{}/releases/tags/{encoded}",
                crate::release::RELEASE_REPOSITORY
            );
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|error| error.to_string())?;
            let mut request = client
                .get(&url)
                .header("accept", "application/vnd.github+json")
                .header("x-github-api-version", "2022-11-28")
                .header("user-agent", "devboard-release-train");
            if let Some(token) = token.as_deref() {
                request = request.header("authorization", format!("Bearer {token}"));
            }
            let response = request.send().await.map_err(|error| error.to_string())?;
            if response.status() == reqwest::StatusCode::NOT_FOUND {
                return Ok(None);
            }
            if !response.status().is_success() {
                return Err(format!("GitHub answered {}", response.status()));
            }
            let body = response.text().await.map_err(|error| error.to_string())?;
            let parsed: Value = serde_json::from_str(&body).map_err(|error| error.to_string())?;
            let names = parsed
                .get("assets")
                .and_then(Value::as_array)
                .map(|assets| {
                    assets
                        .iter()
                        .filter_map(|asset| asset.get("name").and_then(Value::as_str))
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            Ok(Some(names))
        })
    })
}

fn origin_slug(repo_dir: &Path) -> Option<(String, String)> {
    let remote = git_stdout(repo_dir, &["remote", "get-url", "origin"])?;
    let remote = remote.trim();
    if remote.is_empty() {
        return None;
    }
    let cleaned = remote.trim_end_matches('/').trim_end_matches(".git");
    let (host, path) = if let Some(rest) = cleaned.strip_prefix("git@") {
        let (host, path) = rest.split_once(':')?;
        (host.to_string(), path.to_string())
    } else if let Some(rest) = cleaned.split_once("://").map(|(_, rest)| rest) {
        let (host, path) = rest.split_once('/')?;
        (host.to_string(), path.to_string())
    } else {
        return None;
    };
    if host.is_empty() || path.is_empty() {
        return None;
    }
    Some((host, path.trim_matches('/').to_string()))
}

fn default_release_reader(
    repo_dir: PathBuf,
    environment: HashMap<String, String>,
) -> ReadReleaseFn {
    Arc::new(move |tag: String| {
        let repo_dir = repo_dir.clone();
        let environment = environment.clone();
        Box::pin(async move {
            let (host, project) =
                origin_slug(&repo_dir).ok_or_else(|| "no Gitea origin".to_string())?;
            let base = env_value(&environment, &["DEVBOARD_GITEA_URL", "GITEA_URL"])
                .unwrap_or_else(|| format!("https://{host}"));
            let base = base.trim_end_matches('/').to_string();
            let token = env_value(&environment, &["GITEA_TOKEN", "DEVBOARD_GITEA_TOKEN"]);
            let encoded: Vec<String> = project
                .split('/')
                .map(|segment| url::form_urlencoded::byte_serialize(segment.as_bytes()).collect())
                .collect();
            let api = format!(
                "{base}/api/v1/repos/{}/releases/tags/{tag}",
                encoded.join("/")
            );
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|error| error.to_string())?;
            let mut request = client.get(&api).header("accept", "application/json");
            if let Some(token) = &token {
                request = request.header("authorization", format!("token {token}"));
            }
            let response = request.send().await.map_err(|error| error.to_string())?;
            if response.status() == reqwest::StatusCode::NOT_FOUND {
                return Ok(None);
            }
            if !response.status().is_success() {
                return Err(format!("Gitea answered {}", response.status()));
            }
            let body = response.text().await.map_err(|error| error.to_string())?;
            let parsed: Value = serde_json::from_str(&body).map_err(|error| error.to_string())?;
            let asset_names = parsed
                .get("assets")
                .and_then(Value::as_array)
                .map(|assets| {
                    assets
                        .iter()
                        .filter_map(|asset| asset.get("name").and_then(Value::as_str))
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            Ok(Some(ForgeRelease {
                asset_names,
                url: format!("{base}/{project}/releases/tag/{tag}"),
            }))
        })
    })
}

/* ------------------------------------------------------------------------ */
/* The run request and result                                                */
/* ------------------------------------------------------------------------ */

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseTrainRequest {
    pub format: i64,
    pub run_id: String,
    pub range: String,
    pub target: String,
    pub version: String,
    pub previous: Option<String>,
    pub commits: Vec<ReleaseTrainCommit>,
    pub release_commits: Vec<ReleaseTrainCommit>,
}

pub type ActivityFn = Arc<dyn Fn(&str) + Send + Sync>;
pub type StopFlag = Arc<dyn Fn() -> bool + Send + Sync>;

/// The two bounds on one release run: how long its peer may stay silent, and
/// how long the whole run may last.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReleaseRunTimeouts {
    pub silence: Duration,
    pub max: Duration,
}

impl Default for ReleaseRunTimeouts {
    fn default() -> Self {
        Self {
            silence: Duration::from_millis(RUN_SILENCE_MS),
            max: Duration::from_millis(RUN_MAX_MS),
        }
    }
}

/// One bound in the words a failure detail uses.
fn window_label(window: Duration) -> String {
    let millis = window.as_millis() as u64;
    if millis < 60_000 {
        format!("{millis} ms")
    } else {
        format!("{} minutes", millis / 60_000)
    }
}

/// What a run records when its peer stopped reporting progress.
fn silence_detail(timeouts: ReleaseRunTimeouts) -> String {
    format!(
        "the release agent produced no output for {}",
        window_label(timeouts.silence)
    )
}

/// What a run records when it hit the outer bound while its peer was busy.
fn max_detail(timeouts: ReleaseRunTimeouts) -> String {
    format!(
        "the release agent did not finish within {}",
        window_label(timeouts.max)
    )
}

pub type RunFuture = Pin<Box<dyn Future<Output = ReleaseRunResult> + Send>>;
pub type RunReleaseFn = Arc<dyn Fn(ReleaseRunInput) -> RunFuture + Send + Sync>;
pub type PublishFuture =
    Pin<Box<dyn Future<Output = anyhow::Result<crate::publish::PublishReport>> + Send>>;
pub type PublishFn = Arc<dyn Fn(crate::publish::PublishArgs) -> PublishFuture + Send + Sync>;
pub type VerifyFn = Arc<
    dyn Fn(ReleaseVerificationOptions) -> Pin<Box<dyn Future<Output = ReleaseVerification> + Send>>
        + Send
        + Sync,
>;

#[derive(Clone)]
pub struct ReleaseRunInput {
    pub request: ReleaseTrainRequest,
    /// Appends one line to the run's and the family's activity.
    pub activity: ActivityFn,
    /// The worker's stop flag; a release never starts after it is set.
    pub stopping: StopFlag,
    /// The absolute run directory the release reads and answers into.
    pub run_dir: PathBuf,
    pub repo_dir: PathBuf,
    pub state_dir: PathBuf,
    /// The command the default release path names in its diagnostics.
    pub agent_command: String,
    /// How long the peer may stay silent, and how long the run may last.
    pub timeouts: ReleaseRunTimeouts,
    /// Records the peer this run started, so the state names it and Stop can
    /// close it.
    pub register_peer: Arc<dyn Fn(ReleasePeer) + Send + Sync>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReleaseRunResult {
    Ok { version: String, url: String },
    Failed { detail: String },
}

impl ReleaseRunResult {
    pub fn failed(detail: impl Into<String>) -> Self {
        ReleaseRunResult::Failed {
            detail: detail.into(),
        }
    }
}

/// The run's outcome document, at `<run-dir>/result.json`.
pub fn read_result(run_dir: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(run_dir.join("result.json")).ok()?;
    let parsed: Value = serde_json::from_str(&text).ok()?;
    parsed.as_object()?;
    Some(parsed)
}

fn write_run_activity(run_dir: &Path, lines: &[String]) {
    let start = lines.len().saturating_sub(ACTIVITY_MAX_ENTRIES);
    let bounded = &lines[start..];
    if std::fs::create_dir_all(run_dir).is_err() {
        return;
    }
    if let Ok(text) = serde_json::to_string(bounded) {
        let _ = std::fs::write(run_dir.join("activity.json"), format!("{text}\n"));
    }
}

/// The default release path: the native binary's `publish` command, then an
/// independent read of the release it proved. The tests replace the `publish`
/// and `verify` options; production keeps both defaults.
pub fn default_release_runner(
    verify: VerifyFn,
    publish: PublishFn,
    environment: HashMap<String, String>,
) -> RunReleaseFn {
    Arc::new(move |input: ReleaseRunInput| {
        let verify = verify.clone();
        let publish = publish.clone();
        let environment = environment.clone();
        Box::pin(async move { run_release_and_verify(input, verify, publish, environment).await })
    })
}

/// One POSIX shell word, single-quoted with embedded quotes escaped.
fn shell_quote(value: &str) -> String {
    // A URL or token needs no quoting, and an unquoted assignment is read the
    // same way by every consumer, including one that parses the file instead
    // of sourcing it.
    let safe = !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-~:/+=,@".contains(&byte));
    if safe {
        value.to_string()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

/// The production release path: one `omp acp` peer running
/// `/release-train <run-dir>`, then the same independent verification.
pub fn default_release_agent_runner(
    verify: VerifyFn,
    environment: HashMap<String, String>,
) -> RunReleaseFn {
    Arc::new(move |input: ReleaseRunInput| {
        let verify = verify.clone();
        let environment = environment.clone();
        Box::pin(async move { run_release_agent(input, verify, environment).await })
    })
}

/// The detail one failed verification records, composed with what the run
/// already reported.
///
/// A release that did not publish leaves no tag naming its commit, so the
/// verification's tag phase reads that absence back as a missing tag. The
/// run's own failure is the cause, and naming the tag phase beside it would
/// report a phantom second failure. A GitHub or Gitea phase failure still says
/// something the run's report did not, so it always stands beside it.
fn failed_release_detail(
    stopped: bool,
    cause: Option<&str>,
    reported: Option<&str>,
    phase: ReleaseVerificationPhase,
    detail: &str,
) -> String {
    let mut parts: Vec<String> = Vec::new();
    if stopped {
        parts.push("stopped during the release run".to_string());
    }
    let tag_withdrawn = cause.is_some() || reported.is_some();
    if let Some(cause) = cause {
        parts.push(cause.to_string());
    }
    if let Some(report) = reported {
        parts.push(report.to_string());
    }
    if phase != ReleaseVerificationPhase::Tag || !tag_withdrawn {
        parts.push(detail.to_string());
    }
    parts.join("; ")
}

async fn run_release_agent(
    input: ReleaseRunInput,
    verify: VerifyFn,
    environment: HashMap<String, String>,
) -> ReleaseRunResult {
    if (input.stopping)() {
        return ReleaseRunResult::failed("stopped before the release agent started");
    }
    (input.activity)(&format!(
        "starting {} for {}",
        input.agent_command, input.request.range
    ));
    let mut peer_environment = environment.clone();
    peer_environment.insert(
        "REPO_DIR".to_string(),
        input.repo_dir.to_string_lossy().into_owned(),
    );
    peer_environment.insert(
        "STATE_DIR".to_string(),
        input.state_dir.to_string_lossy().into_owned(),
    );
    peer_environment.insert(
        "DEVBOARD_RELEASE_RUN_DIR".to_string(),
        input.run_dir.to_string_lossy().into_owned(),
    );
    // The agent's tool shell may not inherit every variable the worker was
    // started with, so the forge coordinates ride in a private file beside the
    // request; the prompt sources it before running publish.
    let env_path = input.run_dir.join("env.sh");
    if std::fs::create_dir_all(&input.run_dir).is_ok() {
        let mut script = String::new();
        for key in [
            "DEVBOARD_GITEA_URL",
            "GITEA_URL",
            "GITEA_TOKEN",
            "DEVBOARD_GITEA_TOKEN",
            "DEVBOARD_RELEASE_REPO",
        ] {
            if let Some(value) = peer_environment.get(key) {
                script.push_str(&format!("export {key}={}\n", shell_quote(value)));
            }
        }
        let _ = std::fs::write(&env_path, script);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let _ = std::fs::set_permissions(&env_path, std::fs::Permissions::from_mode(0o600));
        }
    }
    let mcp_servers = crate::acp::session_mcp_servers(&peer_environment);
    let options = crate::acp::AcpConnectionOptions::new(
        input.agent_command.clone(),
        input.repo_dir.to_string_lossy().into_owned(),
    )
    .with_starter("Release Train")
    .with_env(peer_environment)
    .with_mcp_servers(mcp_servers)
    .with_permission_policy(crate::acp::PermissionPolicy::Deny);
    let connection = match crate::acp::AcpConnection::connect(options).await {
        Ok((connection, events)) => (connection, events),
        Err(error) => {
            return ReleaseRunResult::failed(format!("could not start the release agent: {error}"))
        }
    };
    let (connection, mut events) = connection;
    if let Some(pid) = connection.pid() {
        let argv = connection.argv();
        let command = argv.join(" ");
        (input.register_peer)(ReleasePeer {
            command,
            pid,
            argv,
            started_at: crate::journal::now_iso8601(),
        });
    }
    let prompt = format!("/release-train {}", input.run_dir.to_string_lossy());
    let future = connection.run(&prompt);
    tokio::pin!(future);
    // Two bounds: the peer may work for hours as long as it keeps reporting
    // progress, but a peer that reports nothing for the silence window is
    // stuck, and one that reports forever still ends at the outer bound.
    let started = tokio::time::Instant::now();
    let max_deadline = started + input.timeouts.max;
    let mut silence_deadline = started + input.timeouts.silence;
    let mut agent_error: Option<String> = None;
    let mut text = String::new();
    loop {
        if (input.stopping)() {
            connection.close();
            agent_error = Some("stopped during the release run".to_string());
            break;
        }
        tokio::select! {
            result = &mut future => {
                match result {
                    Ok(_) => {}
                    Err(error) => agent_error = Some(error.to_string()),
                }
                break;
            }
            event = events.recv() => {
                // Every frame — a message chunk, a tool update, or a stderr
                // line — proves the peer is alive, so it pushes the silence
                // bound out even while one long publish keeps it working.
                let reported = event.is_some();
                match event {
                    Some(crate::acp::AcpEvent::Text(chunk)) => text.push_str(&chunk),
                    Some(crate::acp::AcpEvent::Question(question)) => {
                        if let Some(choice) = question
                            .options
                            .iter()
                            .find(|option| option.recommended)
                            .or_else(|| question.options.first())
                        {
                            let _ = connection.answer(&question.id, &choice.label).await;
                        }
                    }
                    Some(crate::acp::AcpEvent::Stderr(chunk)) => {
                        if let Some(line) = chunk.lines().map(str::trim).find(|line| !line.is_empty()) {
                            if line != "no diagnostic" {
                                (input.activity)(line);
                            }
                        }
                    }
                    Some(_) => {}
                    None => {}
                }
                if reported {
                    silence_deadline = tokio::time::Instant::now() + input.timeouts.silence;
                }
            }
            _ = tokio::time::sleep_until(silence_deadline) => {
                connection.close();
                agent_error = Some(silence_detail(input.timeouts));
                break;
            }
            _ = tokio::time::sleep_until(max_deadline) => {
                connection.close();
                agent_error = Some(max_detail(input.timeouts));
                break;
            }
            _ = tokio::time::sleep(Duration::from_millis(100)) => {
                if (input.stopping)() {
                    connection.close();
                    agent_error = Some("stopped during the release run".to_string());
                    break;
                }
            }
        }
    }
    connection.close();
    let _ = text;
    let stopped = (input.stopping)();
    if stopped {
        (input.activity)("stopped during the release run; verifying what it shipped");
    }
    let result = read_result(&input.run_dir);
    // A peer's publish may prove a version other than the range this run was
    // handed when main moved past the failed version's tag. Its report names
    // the release it published, so verify that release, exactly as the native
    // publish path does; verifying the handed version instead would fail after
    // a successful release and repeat that failure on every tick.
    let published = result.as_ref().and_then(|value| {
        if value.get("ok").and_then(Value::as_bool) != Some(true) {
            return None;
        }
        let sha = value
            .get("sha")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|sha| !sha.is_empty())?;
        let version = value
            .get("version")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|version| !version.is_empty())?;
        Some((sha.to_string(), version.to_string()))
    });
    let (target, version) = match published {
        Some((sha, version)) => {
            if version != input.request.version {
                (input.activity)(&format!(
                    "publish released v{version} instead of the requested v{}; verifying the published release",
                    input.request.version
                ));
            }
            (sha, version)
        }
        None => (input.request.target.clone(), input.request.version.clone()),
    };
    let verified = verify(ReleaseVerificationOptions {
        repo_dir: input.repo_dir.clone(),
        target,
        version,
        environment,
        activity: input.activity.clone(),
        refresh: None,
        read_github_assets: None,
        read_release: None,
        read_retry: None,
    })
    .await;
    match verified {
        ReleaseVerification::Ok { version, url } => {
            if let Some(error) = agent_error {
                (input.activity)(&format!(
                    "the agent ended with: {error}; the release is verified"
                ));
            }
            ReleaseRunResult::Ok { version, url }
        }
        ReleaseVerification::Failed { phase, detail, .. } => {
            let reported = result
                .as_ref()
                .filter(|value| value.get("ok").and_then(Value::as_bool) == Some(false))
                .and_then(|value| value.get("detail").and_then(Value::as_str))
                .map(str::trim)
                .filter(|detail| !detail.is_empty())
                .map(str::to_string);
            // A peer that reports a failed publish withdraws the tag it
            // created just as the native publish does, so its report is the
            // cause this tag phase reads back.
            ReleaseRunResult::failed(failed_release_detail(
                stopped,
                agent_error.as_deref(),
                reported.as_deref(),
                phase,
                &detail,
            ))
        }
    }
}

async fn run_release_and_verify(
    input: ReleaseRunInput,
    verify: VerifyFn,
    publish: PublishFn,
    environment: HashMap<String, String>,
) -> ReleaseRunResult {
    if (input.stopping)() {
        return ReleaseRunResult::failed("stopped before the release agent started");
    }
    (input.activity)(&format!(
        "starting {} for {}",
        input.agent_command, input.request.range
    ));
    let mut publish_args = crate::publish::PublishArgs::new(input.repo_dir.clone());
    publish_args.environment = environment.clone();
    publish_args.wait_timeout = input.timeouts.silence;
    publish_args.log = {
        let activity = input.activity.clone();
        Some(Arc::new(move |line: &str| activity(line)) as Arc<dyn Fn(&str) + Send + Sync>)
    };
    let mut agent_error: Option<String> = None;
    let mut published = None;
    match tokio::time::timeout(input.timeouts.max, publish(publish_args)).await {
        Err(_) => agent_error = Some(max_detail(input.timeouts)),
        Ok(Err(error)) => agent_error = Some(format!("{error:#}")),
        Ok(Ok(report)) => published = Some(report),
    }
    // A stop or drain never skips the verification: the agent may already have
    // published, so the record must say whether the release actually shipped.
    let stopped = (input.stopping)();
    if stopped {
        (input.activity)("stopped during the release run; verifying what it shipped");
    }
    // Verify the release publish actually proved, not the version this run was
    // handed. A retry whose tag was superseded releases the newer range at the
    // integration tip; verifying the handed version instead would fail after a
    // successful release and repeat that failure on every tick.
    let (target, version) = match &published {
        Some(report) => {
            if report.version != input.request.version {
                (input.activity)(&format!(
                    "publish released v{} instead of the requested v{}; verifying the published release",
                    report.version, input.request.version
                ));
            }
            (report.commit.clone(), report.version.clone())
        }
        None => (input.request.target.clone(), input.request.version.clone()),
    };
    let result = read_result(&input.run_dir);
    let verified = verify(ReleaseVerificationOptions {
        repo_dir: input.repo_dir.clone(),
        target,
        version,
        environment,
        activity: input.activity.clone(),
        refresh: None,
        read_github_assets: None,
        read_release: None,
        read_retry: None,
    })
    .await;
    match verified {
        ReleaseVerification::Ok { version, url } => {
            if let Some(error) = agent_error {
                (input.activity)(&format!(
                    "the agent ended with: {error}; the release is verified"
                ));
            }
            ReleaseRunResult::Ok { version, url }
        }
        ReleaseVerification::Failed { phase, detail, .. } => {
            let reported = result
                .as_ref()
                .filter(|value| value.get("ok").and_then(Value::as_bool) == Some(false))
                .and_then(|value| value.get("detail").and_then(Value::as_str))
                .map(str::trim)
                .filter(|detail| !detail.is_empty())
                .map(str::to_string);
            // A publish that failed withdraws the tag it created, so the tag
            // phase then reads that withdrawal back as a missing tag. The
            // publish error is the cause, and naming the tag phase beside it
            // would report a phantom second failure. A GitHub or Gitea phase
            // failure still says something the publish error did not.
            ReleaseRunResult::failed(failed_release_detail(
                stopped,
                agent_error.as_deref(),
                reported.as_deref(),
                phase,
                &detail,
            ))
        }
    }
}

/* ------------------------------------------------------------------------ */
/* The worker                                                                */
/* ------------------------------------------------------------------------ */

pub type LogFn = Arc<dyn Fn(&str) + Send + Sync>;

struct Inner {
    shared: ReleaseTrainState,
    /// Activity lines written since the last shared-state persist, for merge.
    pending_activity: Vec<String>,
    settings: ReleaseTrainSettings,
    worker: Option<ReleaseTrainWorkerRecord>,
    lock: Option<AcquiredLock>,
    stopping: bool,
    paused: bool,
    ticking: bool,
    active_run: Option<ReleaseTrainRun>,
    active_activity: Vec<String>,
    next_run_at_ms: i64,
    last_run_at: Option<String>,
    notice: Option<String>,
}

impl Inner {
    fn new(repo_dir: &Path, now_ms: i64) -> Self {
        Self {
            shared: empty_state("", &repo_dir.to_string_lossy(), now_ms),
            pending_activity: Vec::new(),
            settings: ReleaseTrainSettings::default(),
            worker: None,
            lock: None,
            stopping: false,
            paused: false,
            ticking: false,
            active_run: None,
            active_activity: Vec::new(),
            next_run_at_ms: now_ms,
            last_run_at: None,
            notice: None,
        }
    }
}

/// The options one worker is built from. Unset injection points keep the
/// production behavior; the tests set them.
#[derive(Clone)]
pub struct ReleaseTrainWorkerOptions {
    pub repo_dir: PathBuf,
    pub state_dir: PathBuf,
    pub owner_state_dir: Option<PathBuf>,
    pub harness_version: Option<String>,
    pub environment: Option<HashMap<String, String>>,
    pub agent_command: Option<String>,
    pub tick_ms: Option<u64>,
    pub manual: bool,
    pub now: Option<Clock>,
    /// How long a release run may stay silent, and how long it may last. The
    /// tests shorten both; production keeps the defaults.
    pub timeouts: Option<ReleaseRunTimeouts>,
    pub gate: Option<Arc<dyn Fn(&Path) -> Result<ReleaseTrainGate, String> + Send + Sync>>,
    pub run_release: Option<RunReleaseFn>,
    pub publish: Option<PublishFn>,
    pub verify: Option<VerifyFn>,
    pub log: Option<LogFn>,
}

impl ReleaseTrainWorkerOptions {
    pub fn new(repo_dir: impl Into<PathBuf>, state_dir: impl Into<PathBuf>) -> Self {
        Self {
            repo_dir: repo_dir.into(),
            state_dir: state_dir.into(),
            owner_state_dir: None,
            harness_version: None,
            environment: None,
            agent_command: None,
            tick_ms: None,
            manual: false,
            now: None,
            timeouts: None,
            gate: None,
            run_release: None,
            publish: None,
            verify: None,
            log: None,
        }
    }
}

/// The detached Release Train worker of one harness version.
pub struct ReleaseTrainWorker {
    repo_dir: PathBuf,
    state_dir: PathBuf,
    owner_state_dir: PathBuf,
    harness_version: Option<String>,
    environment: HashMap<String, String>,
    agent_command: String,
    tick_ms: u64,
    clock: Clock,
    timeouts: ReleaseRunTimeouts,
    gate: Arc<dyn Fn(&Path) -> Result<ReleaseTrainGate, String> + Send + Sync>,
    run_release: RunReleaseFn,
    verify: VerifyFn,
    log: LogFn,
    directory: PathBuf,
    version_control_directory: PathBuf,
    version_worker_path: PathBuf,
    inner: Arc<Mutex<Inner>>,
}

impl ReleaseTrainWorker {
    pub fn new(options: ReleaseTrainWorkerOptions) -> Self {
        let repo_dir = absolute(&options.repo_dir);
        let state_dir = absolute(&options.state_dir);
        let owner_state_dir = options
            .owner_state_dir
            .map(|path| absolute(&path))
            .unwrap_or_else(|| state_dir.clone());
        let environment: HashMap<String, String> = options
            .environment
            .unwrap_or_else(|| std::env::vars().collect());
        let harness_version = options.harness_version.or_else(|| {
            environment
                .get("DEVBOARD_HARNESS_VERSION")
                .filter(|value| !value.is_empty())
                .cloned()
                .or_else(|| crate::version::read_harness_version(&repo_dir.join(".devboard")))
        });
        let clock: Clock = options.now.unwrap_or_else(|| Arc::new(now_millis));
        let timeouts = options.timeouts.unwrap_or_default();
        let directory = release_train_directory(&state_dir);
        let version_control_directory =
            versioned_control_directory(&directory, harness_version.as_deref());
        let version_worker_path =
            versioned_worker_state_path(&directory, harness_version.as_deref());
        let now = clock();
        let verify: VerifyFn = options.verify.unwrap_or_else(|| {
            Arc::new(|options: ReleaseVerificationOptions| Box::pin(verify_shipped(options)))
        });
        let uses_publish = options.publish.is_some();
        let publish: PublishFn = options.publish.unwrap_or_else(|| {
            Arc::new(|args: crate::publish::PublishArgs| {
                Box::pin(crate::publish::publish(args)) as PublishFuture
            })
        });
        let run_release = options.run_release.unwrap_or_else(|| {
            if uses_publish {
                default_release_runner(verify.clone(), publish, environment.clone())
            } else {
                default_release_agent_runner(verify.clone(), environment.clone())
            }
        });
        let gate = options.gate.unwrap_or_else(|| {
            let environment = environment.clone();
            Arc::new(move |repo_dir: &Path| {
                Ok(check_release_train(
                    repo_dir,
                    ReleaseTrainGateOptions {
                        credential: gitea_git_credential(repo_dir, &environment),
                        ..ReleaseTrainGateOptions::default()
                    },
                ))
            })
        });
        let inner = Arc::new(Mutex::new(Inner::new(&repo_dir, now)));
        Self {
            repo_dir,
            state_dir,
            owner_state_dir,
            harness_version,
            environment,
            agent_command: options
                .agent_command
                .unwrap_or_else(|| "omp acp".to_string()),
            tick_ms: options.tick_ms.unwrap_or(TICK_MS).max(20),
            clock,
            timeouts,
            gate,
            run_release,
            verify,
            log: options.log.unwrap_or_else(|| Arc::new(|_line: &str| {})),
            directory,
            version_control_directory,
            version_worker_path,
            inner,
        }
    }

    pub fn repo_dir(&self) -> &Path {
        &self.repo_dir
    }

    pub fn state_dir(&self) -> &Path {
        &self.state_dir
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    pub fn harness_version(&self) -> Option<&str> {
        self.harness_version.as_deref()
    }

    pub fn current_state(&self) -> ReleaseTrainState {
        lock_unpoisoned(&self.inner).shared.clone()
    }

    pub fn current_worker(&self) -> Option<ReleaseTrainWorkerRecord> {
        lock_unpoisoned(&self.inner).worker.clone()
    }

    pub fn is_stopping(&self) -> bool {
        lock_unpoisoned(&self.inner).stopping
    }

    fn lock_details(&self) -> LockDetails {
        LockDetails::for_worker(
            &self.repo_dir,
            &self.owner_state_dir,
            self.harness_version.as_deref(),
        )
    }

    /// Takes this version's worker lock; false means another live worker owns
    /// it.
    pub fn begin(&self) -> bool {
        let mut inner = lock_unpoisoned(&self.inner);
        let now = (self.clock)();
        inner.shared = read_state(&self.directory)
            .unwrap_or_else(|| empty_state("", &self.repo_dir.to_string_lossy(), now));
        inner.settings = read_settings(&self.directory);
        let prior = read_worker_state(&self.version_worker_path);
        inner.last_run_at = prior.as_ref().and_then(|state| state.last_run_at.clone());
        inner.next_run_at_ms = prior
            .as_ref()
            .and_then(|state| state.next_run_at.as_deref())
            .and_then(parse_iso_millis)
            .unwrap_or(now);
        let acquisition = acquire_lock(
            &versioned_lock_path(&self.directory, self.harness_version.as_deref()),
            &self.lock_details(),
        );
        let lock = match acquisition {
            LockAcquisition::Acquired(lock) => lock,
            LockAcquisition::Taken { owner } => {
                let pid = owner
                    .as_ref()
                    .map(|owner| format!(" (pid {})", owner.pid))
                    .unwrap_or_default();
                (self.log)(&format!("release train worker: already running{pid}"));
                return false;
            }
        };
        inner.lock = Some(lock);
        let started_at = iso_from_millis(now);
        inner.worker = Some(ReleaseTrainWorkerRecord {
            version: WORKER_VERSION,
            pid: std::process::id(),
            started_at: started_at.clone(),
            root: self.repo_dir.to_string_lossy().into_owned(),
            state_dir: self.owner_state_dir.to_string_lossy().into_owned(),
            lifecycle: AgentLifecycle::Running,
            enabled: true,
            paused: false,
            harness_version: self.harness_version.clone(),
            argv: std::env::args().collect(),
            last_run_at: inner.last_run_at.clone(),
            next_run_at: Some(iso_from_millis(inner.next_run_at_ms)),
            last_error: None,
            notice: None,
            active_run: None,
            updated_at: started_at,
        });
        self.publish_worker(&mut inner);
        true
    }

    /// Runs until Stop or a drain ends the worker.
    pub async fn run(&self) -> i32 {
        if !self.begin() {
            return 0;
        }
        self.consume();
        let mut ticker = tokio::time::interval(Duration::from_millis(self.tick_ms));
        let mut control = tokio::time::interval(Duration::from_millis(CONTROL_POLL_MS));
        ticker.tick().await;
        control.tick().await;
        while !self.is_stopping() {
            tokio::select! {
                _ = ticker.tick() => self.guard_tick().await,
                _ = control.tick() => self.consume(),
            }
        }
        self.finish();
        0
    }

    /// One tick against the injected gate, forced unless `force` is false.
    pub async fn tick_now(&self, force: bool) {
        self.tick(force).await;
    }

    /// Stops this worker; an active run finishes and is verified first.
    pub async fn stop(&self) {
        lock_unpoisoned(&self.inner).stopping = true;
        while lock_unpoisoned(&self.inner).ticking {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        self.finish();
    }

    async fn guard_tick(&self) {
        self.tick(false).await;
    }

    async fn tick(&self, force: bool) {
        let now = (self.clock)();
        {
            let mut inner = lock_unpoisoned(&self.inner);
            if inner.stopping || inner.paused || inner.active_run.is_some() || inner.ticking {
                return;
            }
            if !force && now < inner.next_run_at_ms {
                return;
            }
            inner.ticking = true;
        }
        self.run_tick(now).await;
        let mut inner = lock_unpoisoned(&self.inner);
        inner.ticking = false;
    }

    async fn run_tick(&self, now: i64) {
        let lease = match acquire_lock(&run_lock_path(&self.directory), &self.lock_details()) {
            LockAcquisition::Acquired(lock) => Some(lock),
            LockAcquisition::Taken { .. } => {
                let mut inner = lock_unpoisoned(&self.inner);
                inner.notice = Some(RUN_BUSY_NOTICE.to_string());
                inner.next_run_at_ms = now + 5_000i64.min(self.tick_ms.max(1_000) as i64);
                self.publish_worker(&mut inner);
                return;
            }
        };
        let verdict = (self.gate)(&self.repo_dir);
        let verdict = match verdict {
            Ok(verdict) => verdict,
            Err(detail) => {
                drop(lease);
                self.fail_tick(detail, now);
                return;
            }
        };
        self.record_gate(&verdict, now);
        match verdict {
            ReleaseTrainGate::Error { detail } => {
                self.activity(&format!("release check failed: {detail}"));
                {
                    let mut inner = lock_unpoisoned(&self.inner);
                    inner.notice = Some(detail.clone());
                    if let Some(worker) = inner.worker.as_mut() {
                        worker.last_error = Some(detail);
                    }
                }
                self.finish_tick(now);
            }
            ReleaseTrainGate::Nothing {
                target,
                previous,
                range: _,
            } => {
                if self.retry_failure(&target, now).await {
                    drop(lease);
                    return;
                }
                let covered = previous
                    .as_ref()
                    .map(|tag| tag.tag.clone())
                    .unwrap_or_else(|| "no release tag".to_string());
                self.activity(&format!(
                    "nothing to release: {} is covered by {covered}",
                    short_sha(&target)
                ));
                {
                    let mut inner = lock_unpoisoned(&self.inner);
                    inner.notice = Some("nothing to release".to_string());
                    if let Some(worker) = inner.worker.as_mut() {
                        worker.last_error = None;
                    }
                }
                self.finish_tick(now);
                drop(lease);
            }
            ReleaseTrainGate::Unreleased {
                target,
                previous,
                range,
                version,
                commits,
                release_commits,
            } => {
                self.execute(
                    target,
                    previous,
                    range,
                    version,
                    commits,
                    release_commits,
                    now,
                )
                .await;
                drop(lease);
            }
        }
    }

    /// A tick that errors settles like a failed run: the detail reaches the
    /// shared failure and the worker record, the run it opened is closed, and
    /// the cadence moves a full interval ahead.
    fn fail_tick(&self, detail: String, now: i64) {
        let at = iso_from_millis((self.clock)());
        {
            let mut inner = lock_unpoisoned(&self.inner);
            let run = inner.active_run.take();
            inner.active_activity.clear();
            inner.shared.failure = Some(ReleaseTrainFailure {
                at: at.clone(),
                detail: detail.clone(),
                sha: run
                    .as_ref()
                    .map(|run| run.target.clone())
                    .unwrap_or_default(),
                range: run
                    .as_ref()
                    .map(|run| run.range.clone())
                    .unwrap_or_default(),
                version: run.as_ref().and_then(|run| run.version.clone()),
            });
            if let Some(mut run) = run {
                run.ended_at = Some(at);
                run.state = ReleaseTrainRunState::Failed;
                run.detail = Some(detail.clone());
                inner.shared.runs = record_run(&inner.shared.runs, run);
            }
            if let Some(worker) = inner.worker.as_mut() {
                worker.lifecycle = AgentLifecycle::Failed;
                worker.last_error = Some(detail.clone());
                worker.active_run = None;
            }
        }
        self.activity(&format!("release train tick failed: {detail}"));
        {
            let mut inner = lock_unpoisoned(&self.inner);
            inner.notice = Some(format!("release train tick failed: {detail}"));
            self.publish_worker(&mut inner);
        }
        self.finish_tick(now);
    }

    /// A recorded failure whose own version tag now exists needs no new
    /// agent: verify it and record the outcome.
    async fn retry_failure(&self, tip: &str, now: i64) -> bool {
        let failure = {
            let inner = lock_unpoisoned(&self.inner);
            inner.shared.failure.clone()
        };
        let Some(failure) = failure else {
            return false;
        };
        let Some(version) = failure.version.clone() else {
            return false;
        };
        if !self.failure_is_tagged(&failure, tip) {
            return false;
        }
        let target = failure.sha.clone();
        let run_id = format!("{now}-{}", short_uuid());
        let run = ReleaseTrainRun {
            id: run_id.clone(),
            started_at: iso_from_millis(now),
            ended_at: None,
            state: ReleaseTrainRunState::Running,
            range: failure.range.clone(),
            target: target.clone(),
            version: Some(version.clone()),
            url: None,
            detail: None,
            commits: None,
            peer: None,
        };
        {
            let mut inner = lock_unpoisoned(&self.inner);
            inner.active_run = Some(run.clone());
            inner.active_activity.clear();
            inner.shared.runs = record_run(&inner.shared.runs, run.clone());
            if let Some(worker) = inner.worker.as_mut() {
                worker.active_run = Some(run_id);
                worker.lifecycle = AgentLifecycle::Running;
                inner.notice = Some(format!("verifying {}", failure.range));
            }
            self.publish_worker(&mut inner);
        }
        self.activity(&format!(
            "verifying the failed release of {} as v{version}",
            failure.range
        ));
        let result = (self.verify)(ReleaseVerificationOptions {
            repo_dir: self.repo_dir.clone(),
            target: target.clone(),
            version: version.clone(),
            environment: self.environment.clone(),
            activity: self.activity_callback(),
            refresh: None,
            read_github_assets: None,
            read_release: None,
            read_retry: None,
        })
        .await;
        match result {
            ReleaseVerification::Ok { version, url } => {
                self.settle(
                    run,
                    ReleaseRunResult::Ok {
                        version: version.clone(),
                        url,
                    },
                    &target,
                    &failure.range,
                    Some(version),
                    now,
                );
            }
            ReleaseVerification::Failed { detail, .. } => {
                // The tag exists but its release does not: recover by running
                // the release agent against the existing tag instead of only
                // recording the same failure again.
                self.activity(&format!(
                    "verification failed ({detail}); starting a recovery release"
                ));
                self.execute(
                    target.clone(),
                    None,
                    failure.range.clone(),
                    version.clone(),
                    Vec::new(),
                    Vec::new(),
                    now,
                )
                .await;
            }
        }
        true
    }

    fn failure_is_tagged(&self, failure: &ReleaseTrainFailure, tip: &str) -> bool {
        let Some(version) = failure.version.as_deref() else {
            return false;
        };
        if release_version_at(&self.repo_dir, &failure.sha).as_deref() == Some(version) {
            return true;
        }
        release_tags(&self.repo_dir, tip)
            .iter()
            .any(|tag| tag.version == version)
    }

    async fn execute(
        &self,
        target: String,
        previous: Option<ReleaseTrainTag>,
        range: String,
        version: String,
        commits: Vec<ReleaseTrainCommit>,
        release_commits: Vec<ReleaseTrainCommit>,
        now: i64,
    ) {
        let run_id = format!("{now}-{}", short_uuid());
        let run = ReleaseTrainRun {
            id: run_id.clone(),
            started_at: iso_from_millis(now),
            ended_at: None,
            state: ReleaseTrainRunState::Running,
            range: range.clone(),
            target: target.clone(),
            version: Some(version.clone()),
            url: None,
            detail: None,
            commits: if release_commits.is_empty() {
                None
            } else {
                Some(release_commits.len() as i64)
            },
            peer: None,
        };
        {
            let mut inner = lock_unpoisoned(&self.inner);
            inner.active_run = Some(run.clone());
            inner.active_activity.clear();
            inner.shared.runs = record_run(&inner.shared.runs, run.clone());
            if let Some(worker) = inner.worker.as_mut() {
                worker.active_run = Some(run_id.clone());
                worker.lifecycle = AgentLifecycle::Running;
                inner.notice = Some(format!("releasing {range}"));
            }
            self.publish_worker(&mut inner);
        }
        self.activity(&format!(
            "releasing {range}: {} non-merge commit(s), version {version}",
            release_commits.len()
        ));
        let run_dir = run_directory(&self.directory, &run_id);
        if let Err(error) = std::fs::create_dir_all(&run_dir) {
            self.fail_tick(
                format!(
                    "could not create the run directory {}: {error}",
                    run_dir.display()
                ),
                now,
            );
            return;
        }
        let request = ReleaseTrainRequest {
            format: 1,
            run_id: run_id.clone(),
            range: range.clone(),
            target: target.clone(),
            version: version.clone(),
            previous: previous.map(|tag| tag.tag),
            commits,
            release_commits,
        };
        if let Ok(value) = serde_json::to_value(&request) {
            if let Err(error) = write_json_atomic(&request_path(&self.directory, &run_id), &value) {
                self.fail_tick(
                    format!(
                        "could not write the run request {}: {error}",
                        request_path(&self.directory, &run_id).display()
                    ),
                    now,
                );
                return;
            }
        }
        let active = lock_unpoisoned(&self.inner).active_activity.clone();
        write_run_activity(&run_dir, &active);
        let input = ReleaseRunInput {
            request,
            activity: self.activity_callback(),
            stopping: {
                let inner = self.inner.clone();
                Arc::new(move || lock_unpoisoned(&inner).stopping)
            },
            run_dir: run_dir.clone(),
            repo_dir: self.repo_dir.clone(),
            state_dir: self.state_dir.clone(),
            agent_command: self.agent_command.clone(),
            timeouts: self.timeouts,
            register_peer: {
                let inner = self.inner.clone();
                let run_id = run_id.clone();
                let directory = self.directory.clone();
                Arc::new(move |peer: ReleasePeer| {
                    let mut guard = lock_unpoisoned(&inner);
                    let updated = {
                        let Some(active) = guard.active_run.as_mut() else {
                            return;
                        };
                        if active.id != run_id {
                            return;
                        }
                        active.peer = Some(peer);
                        active.clone()
                    };
                    guard.shared.runs = record_run(&guard.shared.runs, updated);
                    let _ = write_state(&directory, &guard.shared);
                })
            },
        };
        let result = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            (self.run_release)(input)
        })) {
            Ok(future) => future.await,
            Err(_) => ReleaseRunResult::failed("the release agent panicked"),
        };
        let mut run = run;
        run.peer = lock_unpoisoned(&self.inner)
            .active_run
            .as_ref()
            .and_then(|active| active.peer.clone());
        self.settle(run, result, &target, &range, Some(version), now);
    }

    /// Records one run's verified or failed outcome on the shared state.
    fn settle(
        &self,
        mut run: ReleaseTrainRun,
        result: ReleaseRunResult,
        target: &str,
        range: &str,
        version: Option<String>,
        now: i64,
    ) {
        let ended_at = iso_from_millis((self.clock)());
        run.ended_at = Some(ended_at.clone());
        let notice: String;
        match &result {
            ReleaseRunResult::Ok { version, url } => {
                notice = format!("released v{version}");
                {
                    let mut inner = lock_unpoisoned(&self.inner);
                    inner.shared.release = Some(ReleaseTrainRelease {
                        version: version.clone(),
                        url: url.clone(),
                        at: ended_at,
                        sha: target.to_string(),
                        range: range.to_string(),
                    });
                    inner.shared.failure = None;
                    run.state = ReleaseTrainRunState::Released;
                    run.version = Some(version.clone());
                    run.url = Some(url.clone());
                    if let Some(worker) = inner.worker.as_mut() {
                        worker.lifecycle = AgentLifecycle::Running;
                        worker.last_error = None;
                    }
                }
                self.activity(&format!("released v{version}: {url}"));
            }
            ReleaseRunResult::Failed { detail } => {
                notice = format!("release failed: {detail}");
                {
                    let mut inner = lock_unpoisoned(&self.inner);
                    inner.shared.failure = Some(ReleaseTrainFailure {
                        at: ended_at,
                        detail: detail.clone(),
                        sha: target.to_string(),
                        range: range.to_string(),
                        version,
                    });
                    run.state = ReleaseTrainRunState::Failed;
                    run.detail = Some(detail.clone());
                    if let Some(worker) = inner.worker.as_mut() {
                        worker.lifecycle = AgentLifecycle::Failed;
                        worker.last_error = Some(detail.clone());
                    }
                }
                self.activity(&format!("release failed: {detail}"));
            }
        }
        {
            let mut inner = lock_unpoisoned(&self.inner);
            inner.shared.runs = record_run(&inner.shared.runs, run);
            inner.active_run = None;
            inner.notice = Some(notice);
            if let Some(worker) = inner.worker.as_mut() {
                worker.active_run = None;
            }
            self.publish_worker(&mut inner);
        }
        self.finish_tick(now);
    }

    fn record_gate(&self, verdict: &ReleaseTrainGate, now: i64) {
        let mut inner = lock_unpoisoned(&self.inner);
        inner.shared.gate = Some(match verdict {
            ReleaseTrainGate::Error { detail } => ReleaseTrainGateRecord {
                at: iso_from_millis(now),
                state: ReleaseTrainGateState::Error,
                detail: Some(detail.clone()),
                target: None,
                range: None,
                version: None,
            },
            ReleaseTrainGate::Nothing { target, range, .. } => ReleaseTrainGateRecord {
                at: iso_from_millis(now),
                state: ReleaseTrainGateState::Nothing,
                detail: None,
                target: Some(target.clone()),
                range: Some(range.clone()),
                version: None,
            },
            ReleaseTrainGate::Unreleased {
                target,
                range,
                version,
                ..
            } => ReleaseTrainGateRecord {
                at: iso_from_millis(now),
                state: ReleaseTrainGateState::Unreleased,
                detail: None,
                target: Some(target.clone()),
                range: Some(range.clone()),
                version: Some(version.clone()),
            },
        });
    }

    fn finish_tick(&self, now: i64) {
        let mut inner = lock_unpoisoned(&self.inner);
        let last_run_at = iso_from_millis(now);
        inner.last_run_at = Some(last_run_at.clone());
        // The cadence runs from the tick's end, not its start: a run that
        // outlasts the interval still earns a full gap before the next tick.
        let ended_at_ms = (self.clock)();
        inner.next_run_at_ms =
            ended_at_ms + 60_000i64.max(inner.settings.interval_minutes * 60_000);
        let paused = inner.paused;
        let next_run_at = inner.next_run_at_ms;
        if let Some(worker) = inner.worker.as_mut() {
            worker.last_run_at = Some(last_run_at);
            worker.next_run_at = Some(iso_from_millis(next_run_at));
            worker.lifecycle = match (&worker.last_error, paused) {
                (Some(_), _) => AgentLifecycle::Failed,
                (None, true) => AgentLifecycle::Stopped,
                (None, false) => AgentLifecycle::Running,
            };
        }
        self.publish_worker(&mut inner);
        self.persist_shared(&mut inner);
    }

    fn set_notice(&self, inner: &mut Inner, notice: Option<String>) {
        inner.notice = notice;
        self.publish_worker(inner);
    }

    fn activity_callback(&self) -> ActivityFn {
        let inner = self.inner.clone();
        let directory = self.directory.clone();
        let clock = self.clock.clone();
        Arc::new(move |line: &str| {
            let mut state = lock_unpoisoned(&inner);
            let mut shared_activity = std::mem::take(&mut state.shared.activity);
            append_activity(&mut shared_activity, line);
            state.shared.activity = shared_activity;
            state.pending_activity.push(line.to_string());
            let active = state.active_run.clone();
            if let Some(run) = &active {
                let mut run_activity = std::mem::take(&mut state.active_activity);
                append_activity(&mut run_activity, line);
                state.active_activity = run_activity;
                write_run_activity(&run_directory(&directory, &run.id), &state.active_activity);
            }
            persist_shared_locked(&mut state, &directory, &clock);
        })
    }

    fn activity(&self, line: &str) {
        (self.activity_callback())(line);
    }

    fn persist_shared(&self, inner: &mut Inner) {
        persist_shared_locked(inner, &self.directory, &self.clock);
    }

    fn publish_worker(&self, inner: &mut Inner) {
        let notice = inner.notice.clone();
        let Some(worker) = inner.worker.as_mut() else {
            return;
        };
        worker.notice = notice;
        worker.updated_at = iso_from_millis((self.clock)());
        if let Err(error) = write_worker_state(&self.version_worker_path, worker) {
            (self.log)(&format!(
                "could not write the Release Train worker state: {error}"
            ));
        }
    }

    fn finish(&self) {
        let mut inner = lock_unpoisoned(&self.inner);
        inner.notice = None;
        if let Some(worker) = inner.worker.as_mut() {
            worker.lifecycle = AgentLifecycle::Stopped;
            worker.enabled = false;
        }
        self.publish_worker(&mut inner);
        if let Some(lock) = inner.lock.take() {
            lock.release();
        }
    }

    /// Consumes the dashboard's control files between ticks.
    pub fn consume(&self) {
        for command in take_commands(&self.version_control_directory) {
            self.apply(command);
        }
    }

    fn apply(&self, command: ReleaseTrainCommand) {
        match command {
            ReleaseTrainCommand::Stop => {
                lock_unpoisoned(&self.inner).stopping = true;
            }
            ReleaseTrainCommand::Drain => {
                let mut inner = lock_unpoisoned(&self.inner);
                if inner.worker.is_some() {
                    inner.notice = Some("draining after the active run".to_string());
                }
                inner.stopping = true;
                self.publish_worker(&mut inner);
            }
            ReleaseTrainCommand::Pause => {
                let mut inner = lock_unpoisoned(&self.inner);
                inner.paused = true;
                if let Some(worker) = inner.worker.as_mut() {
                    worker.paused = true;
                }
                self.set_notice(&mut inner, Some("paused".to_string()));
            }
            ReleaseTrainCommand::Resume => {
                let mut inner = lock_unpoisoned(&self.inner);
                inner.paused = false;
                inner.next_run_at_ms = (self.clock)();
                if let Some(worker) = inner.worker.as_mut() {
                    worker.paused = false;
                }
                self.set_notice(&mut inner, Some("resumed".to_string()));
            }
            ReleaseTrainCommand::Check => {
                let mut inner = lock_unpoisoned(&self.inner);
                inner.next_run_at_ms = (self.clock)();
                self.set_notice(&mut inner, Some("check requested".to_string()));
            }
            ReleaseTrainCommand::Settings {
                interval_minutes,
                max_per_hour,
                max_pending,
            } => {
                let mut inner = lock_unpoisoned(&self.inner);
                let mut settings = read_settings(&self.directory);
                settings.interval_minutes = interval_minutes;
                settings.max_per_hour = max_per_hour;
                settings.max_pending = max_pending;
                let _ = write_settings(&self.directory, &settings);
                inner.settings = settings;
                let due = (self.clock)() + interval_minutes * 60_000;
                inner.next_run_at_ms = inner.next_run_at_ms.min(due);
                let next_run_at = inner.next_run_at_ms;
                if let Some(worker) = inner.worker.as_mut() {
                    worker.next_run_at = Some(iso_from_millis(next_run_at));
                }
                self.set_notice(
                    &mut inner,
                    Some(format!(
                        "settings saved: every {interval_minutes} minute(s)"
                    )),
                );
            }
        }
    }

    /// Whether a release run is active now.
    pub fn active_run(&self) -> Option<ReleaseTrainRun> {
        lock_unpoisoned(&self.inner).active_run.clone()
    }
}

fn persist_shared_locked(inner: &mut Inner, directory: &Path, clock: &Clock) {
    inner.shared.updated_at = iso_from_millis(clock());
    let disk = read_state(directory);
    let next = match disk {
        None => inner.shared.clone(),
        Some(disk) => merge_state(&inner.shared, &disk, &inner.pending_activity),
    };
    if write_state(directory, &next).is_err() {
        return;
    }
    inner.shared = next;
    inner.pending_activity.clear();
}

fn short_uuid() -> String {
    uuid::Uuid::new_v4().to_string().chars().take(8).collect()
}

fn absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|base| base.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    }
}

/* ------------------------------------------------------------------------ */
/* The page's reads                                                          */
/* ------------------------------------------------------------------------ */

/// Live owners of the family's shared lock, across every harness version.
pub fn release_train_owners(directory: &Path) -> Vec<LockOwner> {
    live_lock_owners(&lock_path(directory))
}

/// One version's worker records, newest first by update time.
pub fn release_train_worker_states(directory: &Path) -> Vec<ReleaseTrainWorkerRecord> {
    let mut states: Vec<ReleaseTrainWorkerRecord> = worker_state_directories(directory)
        .into_iter()
        .filter_map(|worker_directory| read_worker_state(&worker_directory.join("worker.json")))
        .collect();
    states.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    states
}

/// One row of the page's verified-release list.
fn release_row(at: &str, version: &str, commits: Option<i64>, url: Option<&str>) -> Value {
    json!({
        "at": at,
        "version": version,
        "commits": commits,
        "url": url,
    })
}

/// The verified releases, newest first, as the page lists them.
///
/// The newest verified release always appears: its run record can be missing —
/// a shared-state merge regressed it to `running`, or it was trimmed out of the
/// bounded history — while the shared `release` record still names it, so that
/// record supplies the row its run no longer does.
pub fn release_history(directory: &Path, shared: &Value) -> Vec<Value> {
    let runs: Vec<&Value> = shared
        .get("runs")
        .and_then(Value::as_array)
        .map(|entries| entries.iter().collect())
        .unwrap_or_default();
    let mut rows: Vec<Value> = Vec::new();
    let mut listed: HashSet<&str> = HashSet::new();
    for run in &runs {
        if run.get("state").and_then(Value::as_str) != Some("released") {
            continue;
        }
        let Some(version) = run.get("version").and_then(Value::as_str) else {
            continue;
        };
        let commits = run.get("commits").and_then(Value::as_i64).or_else(|| {
            let id = run.get("id").and_then(Value::as_str).unwrap_or("");
            read_run_commit_count(directory, id)
        });
        let at = run
            .get("endedAt")
            .and_then(Value::as_str)
            .or_else(|| run.get("startedAt").and_then(Value::as_str))
            .unwrap_or("");
        rows.push(release_row(
            at,
            version,
            commits,
            run.get("url").and_then(Value::as_str),
        ));
        listed.insert(version);
    }
    if let Some(release) = shared.get("release") {
        let version = release.get("version").and_then(Value::as_str);
        let at = release.get("at").and_then(Value::as_str);
        if let (Some(version), Some(at)) = (version, at) {
            if listed.insert(version) {
                let commits = runs
                    .iter()
                    .find(|run| run.get("version").and_then(Value::as_str) == Some(version))
                    .and_then(|run| {
                        run.get("commits").and_then(Value::as_i64).or_else(|| {
                            let id = run.get("id").and_then(Value::as_str).unwrap_or("");
                            read_run_commit_count(directory, id)
                        })
                    });
                rows.insert(
                    0,
                    release_row(
                        at,
                        version,
                        commits,
                        release.get("url").and_then(Value::as_str),
                    ),
                );
            }
        }
    }
    rows
}

/* ------------------------------------------------------------------------ */
/* The worker entry point                                                    */
/* ------------------------------------------------------------------------ */

fn usage() -> anyhow::Error {
    anyhow::anyhow!(
        "usage: devboard worker release-train --root <checkout> [--state-dir <state>] [--once] [--check] [--json]"
    )
}

/// One cycle of the Release Train family: `--once` runs one forced tick and
/// exits, `--check` prints the deterministic gate without writing state or
/// starting a release, and the plain form runs until Stop or a drain.
pub async fn run(invocation: &WorkerInvocation) -> anyhow::Result<()> {
    let mut root: Option<PathBuf> = None;
    let mut state_dir: Option<PathBuf> = None;
    let mut once = false;
    let mut check = false;
    let mut json_output = false;
    let mut harness_version: Option<String> = None;
    let mut index = 0;
    while index < invocation.rest.len() {
        match invocation.rest[index].as_str() {
            "--root" => {
                root = invocation.rest.get(index + 1).map(PathBuf::from);
                index += 2;
            }
            "--state-dir" => {
                state_dir = invocation.rest.get(index + 1).map(PathBuf::from);
                index += 2;
            }
            "--once" => {
                once = true;
                index += 1;
            }
            "--check" => {
                check = true;
                index += 1;
            }
            "--json" => {
                json_output = true;
                index += 1;
            }
            "--harness-version" => {
                harness_version = invocation.rest.get(index + 1).cloned();
                index += 2;
            }
            "-h" | "--help" => return Err(usage()),
            other => {
                anyhow::bail!("release-train: unexpected argument {other}");
            }
        }
    }
    let repo_dir = if invocation.repo_dir.as_os_str().is_empty() {
        root.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    } else {
        invocation.repo_dir.clone()
    };
    let repo_dir = absolute(&repo_dir);
    let harness = repo_dir.join(".devboard");
    if !harness.exists() {
        eprintln!(
            "release-train: missing prerequisite: {} does not exist",
            harness.display()
        );
        std::process::exit(2);
    }
    if check {
        let gate = check_release_train(&repo_dir, ReleaseTrainGateOptions::default());
        if json_output {
            println!("{}", serde_json::to_string_pretty(&gate.to_json())?);
        } else if let ReleaseTrainGate::Error { detail } = &gate {
            println!("{}: {detail}", gate.state().as_str());
        } else {
            println!("{}", gate.state().as_str());
        }
        if gate.state() == ReleaseTrainGateState::Error {
            std::process::exit(1);
        }
        return Ok(());
    }
    let state_dir = state_dir.unwrap_or_else(|| {
        if invocation.state_dir.as_os_str().is_empty() {
            repo_dir.join(".devboard").join(".tmp")
        } else {
            invocation.state_dir.clone()
        }
    });
    let mut options = ReleaseTrainWorkerOptions::new(repo_dir, state_dir);
    options.harness_version = harness_version;
    let worker = ReleaseTrainWorker::new(options);
    if once {
        if !worker.begin() {
            eprintln!("release-train: another worker of this version is running");
            std::process::exit(2);
        }
        worker.tick_now(true).await;
        worker.stop().await;
        return Ok(());
    }
    let code = worker.run().await;
    if code != 0 {
        std::process::exit(code);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{failed_release_detail, ReleaseVerificationPhase};

    #[test]
    fn a_reported_failure_does_not_repeat_the_withdrawn_tag_phase() {
        assert_eq!(
            failed_release_detail(
                false,
                None,
                Some("release suite: structural failure (compile error), nothing tagged or dispatched"),
                ReleaseVerificationPhase::Tag,
                "tag binding: no release tag names or contains a9a3f33 for v1.39.0",
            ),
            "release suite: structural failure (compile error), nothing tagged or dispatched"
        );
    }

    #[test]
    fn a_github_phase_failure_stands_beside_the_reported_failure() {
        assert_eq!(
            failed_release_detail(
                false,
                None,
                Some("the release workflow concluded failure"),
                ReleaseVerificationPhase::Github,
                "GitHub assets: the release v1.39.0 does not exist",
            ),
            "the release workflow concluded failure; GitHub assets: the release v1.39.0 does not exist"
        );
    }

    #[test]
    fn a_tag_phase_failure_stands_alone_when_the_run_reported_nothing() {
        assert_eq!(
            failed_release_detail(
                true,
                None,
                None,
                ReleaseVerificationPhase::Tag,
                "tag binding: no release tag names or contains a9a3f33 for v1.39.0",
            ),
            "stopped during the release run; tag binding: no release tag names or contains a9a3f33 for v1.39.0"
        );
    }
}

#[cfg(test)]
mod tick_bounds {
    //! The worker's control tick is a housekeeping cadence: at most four
    //! observations a second, never a busy loop.

    #[test]
    fn the_control_tick_is_at_least_250_ms() {
        // Read through a binding so the guard runs at test time: the point is
        // that a later edit to the constant cannot quietly restore a 100 ms
        // poll.
        let tick = super::CONTROL_POLL_MS;
        assert!(tick >= 250, "the control tick is {tick} ms");
    }
}
