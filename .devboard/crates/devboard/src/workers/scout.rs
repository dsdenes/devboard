//! The detached Auto Scout worker: one repository's periodic forge read, one
//! scan at a time, one ACP peer, the repository lock, and the durable state.
//!
//! A scan files its own significant recommendations through the MCP issue
//! tool; the worker reads the agent's tool log as the filing evidence and the
//! forge as the record. The TypeScript reference is
//! `.devboard/issues/scout/{worker,state,paths,control,scan,claims,github,preflight}.ts`.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::acp::{AcpActivity, AcpConnection, AcpConnectionOptions, AcpEvent};
use crate::forge::{
    classify_forge_read_failure, git, gitea_closing_commits, gitea_json, gitea_list_issues,
    gitea_list_labelled_issues, gitea_list_releases, is_forge_read_latency, is_forge_read_outage,
    origin_forge_with, resolve_shipped_version, ClosingCommitClient, ClosingCommitIssue, Forge,
    ForgeReadFailureKind, ForgeReadRetry, GitHubRelease, IssueQueryState, IssueState,
    RepositoryGitHub, RepositoryGitHubOptions, VersionResolution,
};
use crate::journal::repo_key;
use crate::providers::{create_worker_provider_environment, ProviderOptions};
use crate::state::{
    write_state_file, ACTIVITY_MAX_BYTES, ACTIVITY_MAX_ENTRIES, ACTIVITY_TRIMMED_MARKER,
};
use crate::supervision::{live_process, process_age_ms, process_argv};
use crate::version::read_harness_version;
use crate::workers::startup::{inherited_state_path, versioned_state_files};
use crate::workers::WorkerInvocation;

pub const SCOUT_DIRECTORY: &str = "scout";
/// The one label every Auto Scout issue carries, and the label its reads ask
/// the forge for.
pub const SCOUT_LABEL: &str = "scout";
pub const STATE_VERSION: i64 = 2;
pub const SCAN_VERSION: i64 = 2;
/// A scan that filed fewer issues than it requested; `succeeded` means the
/// requested count was reached.
pub const SCAN_STATUS_INCOMPLETE: &str = "incomplete";
/// A scan's agent phase ends after this long without a session update, and its
/// separately timed settle-and-file phase ends after this long in total.
pub const SCAN_TIMEOUT_MS: i64 = 15 * 60_000;
pub const SYNC_INTERVAL_MS: u64 = 60_000;
pub const HOUR_MS: i64 = 60 * 60_000;
pub const DEFAULT_MAX_PER_HOUR: i64 = 10;
pub const DEFAULT_MAX_PENDING: i64 = 5;
pub const DEFAULT_INTERVAL_MINUTES: i64 = 1;
pub const CADENCE_MIN_MINUTES: i64 = 1;
pub const CADENCE_MAX_MINUTES: i64 = 1440;
pub const UNLIMITED_SCAN_BATCH: i64 = 100;
pub const LIMIT_MIN: i64 = 1;
pub const LIMIT_MAX: i64 = 100;
pub const SIGNIFICANCE_THRESHOLD: i64 = 4;
pub const SCAN_PROMPT: &str = "/scout-recommendations";
pub const CATEGORIES: [&str; 6] = [
    "clarity",
    "structure",
    "naming",
    "tests",
    "robustness",
    "correctness",
];
/// How long a closed issue whose release could not be determined waits.
pub const RESOLUTION_RETRY_MS: i64 = 6 * HOUR_MS;
const TICK_MS: u64 = 250;
const FIRST_LINE_MAX: usize = 400;
const MAX_ACTIVITY_LINE: usize = 2000;
const READ_TIMEOUT_MS: u64 = 30_000;
const MIN_SYNC_MS: u64 = 1000;
const START_TIME_TOLERANCE_MS: f64 = 2_000.0;

pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
pub type LogFn = Arc<dyn Fn(&str) + Send + Sync>;

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn absolute(path: impl AsRef<Path>) -> PathBuf {
    let path = path.as_ref();
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
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
    let nanos = millis as i128 * 1_000_000;
    match time::OffsetDateTime::from_unix_timestamp_nanos(nanos) {
        Ok(at) => at
            .to_offset(time::UtcOffset::UTC)
            .format(*ISO_FORMAT)
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

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = (month + 9) % 12;
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/* ------------------------------------------------------------------------ */
/* Paths                                                                     */
/* ------------------------------------------------------------------------ */

pub fn scout_root(state_dir: &Path) -> PathBuf {
    state_dir.join(SCOUT_DIRECTORY)
}

/// `<STATE_DIR>/scout/<repository key>`.
pub fn repo_state_directory(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    scout_root(state_dir).join(repo_key(repo_dir))
}

pub fn state_path(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    repo_state_directory(state_dir, repo_dir).join("state.json")
}

pub fn worker_version_key(version: Option<&str>) -> String {
    let text = version
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown");
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
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
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
        .join(SCOUT_DIRECTORY)
}

/// `<REPO_DIR>/.devboard/.tmp/scout/lock`, versioned beside it.
pub fn lock_path(repo_dir: &Path) -> PathBuf {
    work_directory(repo_dir).join("lock")
}

pub fn version_lock_path(base: &Path, version: Option<&str>) -> PathBuf {
    PathBuf::from(format!(
        "{}.{}",
        base.display(),
        worker_version_key(version)
    ))
}

pub fn scans_directory(repo_dir: &Path) -> PathBuf {
    work_directory(repo_dir).join("scans")
}

pub fn scan_directory(repo_dir: &Path, scan_id: &str) -> PathBuf {
    scans_directory(repo_dir).join(scan_id)
}

pub fn request_path(directory: &Path) -> PathBuf {
    directory.join("request.json")
}

pub fn scan_file_path(directory: &Path) -> PathBuf {
    directory.join("scan.json")
}

pub fn activity_path(directory: &Path) -> PathBuf {
    directory.join("activity.json")
}

/// The activity file of the scan a sampled state names: the newest scan, else
/// the scan still running.
pub fn state_activity_path(repo_dir: &Path, state: &Value) -> Option<PathBuf> {
    let scan_id = state
        .get("newestScanId")
        .and_then(Value::as_str)
        .or_else(|| {
            state
                .get("scan")
                .and_then(|scan| scan.get("scanId"))
                .and_then(Value::as_str)
        })?;
    Some(activity_path(&scan_directory(repo_dir, scan_id)))
}

pub fn scan_claim_path(repo_dir: &Path) -> PathBuf {
    work_directory(repo_dir).join("scan-claim.json")
}

/// A UTC timestamp name, made unique when two scans start in one millisecond.
pub fn run_identifier(now: i64) -> String {
    iso_from_millis(now).replace([':', '.'], "-")
}

/* ------------------------------------------------------------------------ */
/* State                                                                     */
/* ------------------------------------------------------------------------ */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScoutLifecycle {
    Stopped,
    Idle,
    Scanning,
    Failed,
}

impl ScoutLifecycle {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::Idle => "idle",
            Self::Scanning => "scanning",
            Self::Failed => "failed",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "stopped" => Some(Self::Stopped),
            "idle" => Some(Self::Idle),
            "scanning" => Some(Self::Scanning),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScoutIssueState {
    Pending,
    Implemented,
}

impl ScoutIssueState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Implemented => "implemented",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(Self::Pending),
            "implemented" => Some(Self::Implemented),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoutLimits {
    pub max_per_hour: Option<i64>,
    pub max_pending: Option<i64>,
}

impl Default for ScoutLimits {
    fn default() -> Self {
        Self {
            max_per_hour: Some(DEFAULT_MAX_PER_HOUR),
            max_pending: Some(DEFAULT_MAX_PENDING),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoutSettings {
    pub max_per_hour: Option<i64>,
    pub max_pending: Option<i64>,
    pub interval_minutes: i64,
}

impl Default for ScoutSettings {
    fn default() -> Self {
        Self {
            max_per_hour: Some(DEFAULT_MAX_PER_HOUR),
            max_pending: Some(DEFAULT_MAX_PENDING),
            interval_minutes: DEFAULT_INTERVAL_MINUTES,
        }
    }
}

pub fn is_valid_limit(value: Option<i64>) -> bool {
    match value {
        None => true,
        Some(value) => (LIMIT_MIN..=LIMIT_MAX).contains(&value),
    }
}

pub fn is_valid_cadence(value: i64) -> bool {
    (CADENCE_MIN_MINUTES..=CADENCE_MAX_MINUTES).contains(&value)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoutWorkerRecord {
    pub pid: u32,
    /// The pid's kernel start tick, the identity that tells this worker from
    /// a later process the kernel gave the same pid.
    #[serde(default)]
    pub start_ticks: Option<i64>,
    pub started_at: String,
    pub state_dir: String,
    pub harness_version: Option<String>,
    pub argv: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoutIssueRow {
    pub number: i64,
    pub title: String,
    pub url: String,
    pub created_at: String,
    pub state: ScoutIssueState,
    pub category: Option<String>,
    pub version: Option<String>,
    pub version_attempt_at: Option<String>,
    pub version_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoutSync {
    pub state: String,
    pub at: Option<String>,
    pub error: Option<String>,
}

impl Default for ScoutSync {
    fn default() -> Self {
        Self {
            state: "stale".to_string(),
            at: None,
            error: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoutScanRecord {
    pub scan_id: String,
    pub started_at: String,
    pub requested: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoutState {
    pub version: i64,
    pub repo: String,
    pub root: String,
    pub lifecycle: String,
    pub enabled: bool,
    pub worker: Option<ScoutWorkerRecord>,
    pub limits: ScoutLimits,
    pub interval_minutes: i64,
    pub last_scan_started_at: Option<String>,
    pub issues: Vec<ScoutIssueRow>,
    pub open_titles: Vec<String>,
    pub release_signature: Option<String>,
    pub sync: ScoutSync,
    pub scan: Option<ScoutScanRecord>,
    pub newest_scan_id: Option<String>,
    pub next_attempt_at: Option<String>,
    pub last_error: Option<String>,
    pub notice: Option<String>,
    pub updated_at: String,
}

pub fn empty_state(repo: &str, root: &Path, now: i64) -> ScoutState {
    ScoutState {
        version: STATE_VERSION,
        repo: repo.to_string(),
        root: root.to_string_lossy().into_owned(),
        lifecycle: ScoutLifecycle::Stopped.as_str().to_string(),
        enabled: false,
        worker: None,
        limits: ScoutLimits::default(),
        interval_minutes: DEFAULT_INTERVAL_MINUTES,
        last_scan_started_at: None,
        issues: Vec::new(),
        open_titles: Vec::new(),
        release_signature: None,
        sync: ScoutSync::default(),
        scan: None,
        newest_scan_id: None,
        next_attempt_at: None,
        last_error: None,
        notice: None,
        updated_at: iso_from_millis(now),
    }
}

fn nullable_string(value: Option<&Value>) -> Option<Option<String>> {
    match value {
        None | Some(Value::Null) => Some(None),
        Some(Value::String(text)) => Some(Some(text.clone())),
        _ => None,
    }
}

fn value_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_string)
}

fn is_integer(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_i64)
}

fn parse_limits(value: Option<&Value>) -> Option<ScoutLimits> {
    let object = value?.as_object()?;
    let limit = |field: &str| -> Option<Option<i64>> {
        match object.get(field) {
            Some(Value::Null) => Some(None),
            Some(value) => {
                let number = value.as_i64()?;
                if !is_valid_limit(Some(number)) {
                    return None;
                }
                Some(Some(number))
            }
            None => None,
        }
    };
    let max_per_hour = limit("maxPerHour")?;
    let max_pending = limit("maxPending")?;
    Some(ScoutLimits {
        max_per_hour,
        max_pending,
    })
}

fn parse_issue_row(value: &Value) -> Option<ScoutIssueRow> {
    let object = value.as_object()?;
    let number = is_integer(object.get("number"))?;
    if number <= 0 {
        return None;
    }
    let title = value_string(object.get("title"))?;
    let url = value_string(object.get("url"))?;
    let created_at = value_string(object.get("createdAt"))?;
    let state = ScoutIssueState::parse(object.get("state")?.as_str()?)?;
    let category = nullable_string(object.get("category"))?;
    let version = nullable_string(object.get("version"))?;
    let version_attempt_at = nullable_string(object.get("versionAttemptAt"))?;
    let version_error = nullable_string(object.get("versionError"))?;
    Some(ScoutIssueRow {
        number,
        title,
        url,
        created_at,
        state,
        category,
        version,
        version_attempt_at,
        version_error,
    })
}

fn parse_worker(value: &Value) -> Option<ScoutWorkerRecord> {
    let object = value.as_object()?;
    let pid = is_integer(object.get("pid"))?;
    if pid <= 0 {
        return None;
    }
    let argv = object
        .get("argv")?
        .as_array()?
        .iter()
        .map(|entry| entry.as_str().map(str::to_string))
        .collect::<Option<Vec<String>>>()?;
    Some(ScoutWorkerRecord {
        pid: pid as u32,
        start_ticks: object.get("startTicks").and_then(Value::as_i64),
        started_at: value_string(object.get("startedAt"))?,
        state_dir: value_string(object.get("stateDir"))?,
        harness_version: nullable_string(object.get("harnessVersion"))?,
        argv,
    })
}

fn parse_scan_record(value: &Value) -> Option<ScoutScanRecord> {
    let object = value.as_object()?;
    Some(ScoutScanRecord {
        scan_id: value_string(object.get("scanId"))?,
        started_at: value_string(object.get("startedAt"))?,
        requested: is_integer(object.get("requested"))?,
    })
}

fn parse_sync(value: &Value) -> Option<ScoutSync> {
    let object = value.as_object()?;
    let state = value_string(object.get("state"))?;
    if !matches!(state.as_str(), "ok" | "error" | "stale") {
        return None;
    }
    Some(ScoutSync {
        state,
        at: nullable_string(object.get("at"))?,
        error: nullable_string(object.get("error"))?,
    })
}

/// Parses one version-2 document; `None` means the bytes are not ours.
pub fn parse_state(text: &str) -> Option<ScoutState> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    let object = parsed.as_object()?;
    if is_integer(object.get("version"))? != STATE_VERSION {
        return None;
    }
    let repo = value_string(object.get("repo"))?;
    let root = value_string(object.get("root"))?;
    let lifecycle = ScoutLifecycle::parse(object.get("lifecycle")?.as_str()?)?;
    let enabled = object.get("enabled")?.as_bool()?;
    let worker = match object.get("worker")? {
        Value::Null => None,
        value => Some(parse_worker(value)?),
    };
    let limits = parse_limits(object.get("limits"))?;
    let interval_minutes = match object.get("intervalMinutes") {
        None => DEFAULT_INTERVAL_MINUTES,
        Some(value) => {
            let value = is_integer(Some(value))?;
            if !is_valid_cadence(value) {
                return None;
            }
            value
        }
    };
    let last_scan_started_at = nullable_string(object.get("lastScanStartedAt"))?;
    let issues = object
        .get("issues")?
        .as_array()?
        .iter()
        .map(parse_issue_row)
        .collect::<Option<Vec<_>>>()?;
    let open_titles: Vec<String> = object
        .get("openTitles")
        .map(|value| {
            value.as_array().and_then(|entries| {
                entries
                    .iter()
                    .map(|entry| entry.as_str().map(str::to_string))
                    .collect()
            })
        })
        .unwrap_or_else(|| Some(Vec::new()))?;
    let release_signature = nullable_string(object.get("releaseSignature"))?;
    let sync = parse_sync(object.get("sync")?)?;
    let scan = match object.get("scan")? {
        Value::Null => None,
        value => Some(parse_scan_record(value)?),
    };
    let newest_scan_id = nullable_string(object.get("newestScanId"))?;
    let next_attempt_at = nullable_string(object.get("nextAttemptAt"))?;
    let last_error = nullable_string(object.get("lastError"))?;
    let notice = nullable_string(object.get("notice"))?;
    let updated_at = value_string(object.get("updatedAt"))?;
    Some(ScoutState {
        version: STATE_VERSION,
        repo,
        root,
        lifecycle: lifecycle.as_str().to_string(),
        enabled,
        worker,
        limits,
        interval_minutes,
        last_scan_started_at,
        issues,
        open_titles,
        release_signature,
        sync,
        scan,
        newest_scan_id,
        next_attempt_at,
        last_error,
        notice,
        updated_at,
    })
}

/// A version-1 board kept only its staging array and its decisions; the staged
/// recommendations are discarded and both limits take their defaults.
pub fn migrate_state(text: &str) -> Option<ScoutState> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    let object = parsed.as_object()?;
    if is_integer(object.get("version"))? != 1 {
        return None;
    }
    let repo = value_string(object.get("repo"))?;
    let root = value_string(object.get("root"))?;
    let lifecycle = ScoutLifecycle::parse(object.get("lifecycle")?.as_str()?)?;
    let enabled = object.get("enabled")?.as_bool()?;
    let worker = match object.get("worker")? {
        Value::Null => None,
        value => Some(parse_worker(value)?),
    };
    let discarded = object.get("staged")?.as_array()?.len();
    let scan = match object.get("scan")? {
        Value::Null => None,
        value => Some(parse_scan_record(value)?),
    };
    let newest_scan_id = nullable_string(object.get("newestScanId"))?;
    let last_error = nullable_string(object.get("lastError"))?;
    let notice = nullable_string(object.get("notice"))?;
    let updated_at = value_string(object.get("updatedAt"))?;
    Some(ScoutState {
        version: STATE_VERSION,
        repo,
        root,
        lifecycle: lifecycle.as_str().to_string(),
        enabled,
        worker,
        limits: ScoutLimits::default(),
        interval_minutes: DEFAULT_INTERVAL_MINUTES,
        last_scan_started_at: None,
        issues: Vec::new(),
        open_titles: Vec::new(),
        release_signature: None,
        sync: ScoutSync::default(),
        scan,
        newest_scan_id,
        next_attempt_at: None,
        last_error,
        notice: if discarded == 0 {
            notice
        } else {
            Some(format!(
                "Discarded {discarded} staged recommendation{} from the previous Auto Scout \
                 version; nothing was filed.",
                if discarded == 1 { "" } else { "s" }
            ))
        },
        updated_at,
    })
}

/// Reads without side effects; a version-1 file is migrated in memory.
pub fn read_state(path: &Path) -> Option<ScoutState> {
    let text = std::fs::read_to_string(path).ok()?;
    parse_state(&text).or_else(|| migrate_state(&text))
}

pub fn quarantine(path: &Path) -> Option<PathBuf> {
    let stamp = iso_from_millis(now_millis()).replace([':', '.'], "-");
    for attempt in 0..10 {
        let target = PathBuf::from(format!(
            "{}.invalid-{stamp}{}",
            path.display(),
            if attempt == 0 {
                String::new()
            } else {
                format!("-{attempt}")
            }
        ));
        if target.exists() {
            continue;
        }
        return std::fs::rename(path, &target).ok().map(|_| target);
    }
    None
}

/// Reads and migrates, moving an unusable file aside, preserved.
pub fn load_state(path: &Path) -> Option<ScoutState> {
    if !path.exists() {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    let state = parse_state(&text).or_else(|| migrate_state(&text));
    if state.is_some() {
        return state;
    }
    quarantine(path);
    None
}

/// Temporary file plus rename: no reader ever sees a prefix of a state.
pub fn write_state(path: &Path, state: &ScoutState) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(state)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    write_state_file(path, &format!("{text}\n"))
}

pub fn write_atomic(path: &Path, content: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    let result = (|| {
        std::fs::write(&temporary, content)?;
        std::fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

/* ------------------------------------------------------------------------ */
/* Settings                                                                  */
/* ------------------------------------------------------------------------ */

pub fn parse_settings(text: &str) -> Option<ScoutSettings> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    let limits = parse_limits(Some(&parsed))?;
    let object = parsed.as_object()?;
    let interval_minutes = match object.get("intervalMinutes") {
        None => DEFAULT_INTERVAL_MINUTES,
        Some(value) => {
            let value = is_integer(Some(value))?;
            if !is_valid_cadence(value) {
                return None;
            }
            value
        }
    };
    Some(ScoutSettings {
        max_per_hour: limits.max_per_hour,
        max_pending: limits.max_pending,
        interval_minutes,
    })
}

pub fn read_settings(path: &Path) -> Option<ScoutSettings> {
    parse_settings(&std::fs::read_to_string(path).ok()?)
}

pub fn write_settings(path: &Path, settings: &ScoutSettings) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(settings)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    write_atomic(path, &format!("{text}\n"))
}

/* ------------------------------------------------------------------------ */
/* Scan records                                                              */
/* ------------------------------------------------------------------------ */

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoutAcpChild {
    pub pid: u32,
    pub argv: Vec<String>,
    pub cwd: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoutScanFile {
    pub version: i64,
    pub scan_id: String,
    pub repo: String,
    pub root: String,
    pub status: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub requested: i64,
    pub filed: i64,
    pub prompt: String,
    pub acp: Option<ScoutAcpChild>,
    pub error: Option<String>,
    pub shortfall: Option<String>,
    pub worker_pid: u32,
    pub harness_version: Option<String>,
}

fn parse_acp_child(value: &Value) -> Option<ScoutAcpChild> {
    let object = value.as_object()?;
    let pid = is_integer(object.get("pid"))?;
    if pid <= 0 {
        return None;
    }
    let argv = object
        .get("argv")?
        .as_array()?
        .iter()
        .map(|entry| entry.as_str().map(str::to_string))
        .collect::<Option<Vec<String>>>()?;
    Some(ScoutAcpChild {
        pid: pid as u32,
        argv,
        cwd: value_string(object.get("cwd"))?,
    })
}

/// Reads a version-2 record; a version-1 record's `staged` becomes `filed`.
pub fn parse_scan_file(text: &str) -> Option<ScoutScanFile> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    let object = parsed.as_object()?;
    let version = is_integer(object.get("version"))?;
    if version != 1 && version != SCAN_VERSION {
        return None;
    }
    let scan_id = value_string(object.get("scanId"))?;
    let repo = value_string(object.get("repo"))?;
    let root = value_string(object.get("root"))?;
    let status = value_string(object.get("status"))?;
    if !matches!(
        status.as_str(),
        "running" | "succeeded" | "failed" | "stopped" | SCAN_STATUS_INCOMPLETE
    ) {
        return None;
    }
    let started_at = value_string(object.get("startedAt"))?;
    let finished_at = nullable_string(object.get("finishedAt"))?;
    let requested = is_integer(object.get("requested"))?;
    let filed = if version == 1 {
        is_integer(object.get("staged"))?
    } else {
        is_integer(object.get("filed"))?
    };
    let prompt = value_string(object.get("prompt"))?;
    let acp = match object.get("acp")? {
        Value::Null => None,
        value => Some(parse_acp_child(value)?),
    };
    let error = nullable_string(object.get("error"))?;
    let shortfall = nullable_string(object.get("shortfall"))?;
    let worker_pid = is_integer(object.get("workerPid"))?;
    let harness_version = nullable_string(object.get("harnessVersion"))?;
    Some(ScoutScanFile {
        version: SCAN_VERSION,
        scan_id,
        repo,
        root,
        status,
        started_at,
        finished_at,
        requested,
        filed,
        prompt,
        acp,
        error,
        shortfall,
        worker_pid: worker_pid as u32,
        harness_version,
    })
}

pub fn read_scan_file(directory: &Path) -> Option<ScoutScanFile> {
    parse_scan_file(&std::fs::read_to_string(scan_file_path(directory)).ok()?)
}

pub fn write_scan_file(directory: &Path, scan: &ScoutScanFile) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(scan)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    write_atomic(&scan_file_path(directory), &format!("{text}\n"))
}

/* ------------------------------------------------------------------------ */
/* Activity                                                                  */
/* ------------------------------------------------------------------------ */

fn trim_activity_lines(lines: &mut Vec<String>) {
    let bytes: usize = lines.iter().map(String::len).sum();
    if lines.len() <= ACTIVITY_MAX_ENTRIES && bytes <= ACTIVITY_MAX_BYTES {
        return;
    }
    let marker_bytes = ACTIVITY_TRIMMED_MARKER.len();
    let mut kept: Vec<String> = Vec::new();
    let mut kept_bytes = marker_bytes;
    for line in lines.iter().rev() {
        let size = line.len();
        let entries = kept.len() + 2;
        if !kept.is_empty()
            && (entries > ACTIVITY_MAX_ENTRIES || kept_bytes + size > ACTIVITY_MAX_BYTES)
        {
            break;
        }
        kept.insert(0, line.clone());
        kept_bytes += size;
    }
    *lines = vec![ACTIVITY_TRIMMED_MARKER.to_string()];
    lines.extend(kept);
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
    trim_activity_lines(lines);
}

pub fn write_activity(directory: &Path, lines: &[String]) -> std::io::Result<()> {
    std::fs::create_dir_all(directory)?;
    let text = serde_json::to_string(lines)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    write_atomic(&activity_path(directory), &format!("{text}\n"))
}

/* ------------------------------------------------------------------------ */
/* Control commands                                                          */
/* ------------------------------------------------------------------------ */

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScoutCommand {
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

pub fn write_command(directory: &Path, command: &ScoutCommand) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(directory)?;
    let sequence = COMMAND_SEQUENCE.fetch_add(1, Ordering::SeqCst) + 1;
    let name = format!("{:014}-{:06}.json", now_millis(), sequence % 1_000_000);
    let path = directory.join(name);
    let value = match command {
        ScoutCommand::Stop => json!({"type": "stop"}),
        ScoutCommand::Drain => json!({"type": "drain"}),
        ScoutCommand::Refresh => json!({"type": "refresh"}),
        ScoutCommand::Settings {
            interval_minutes,
            max_per_hour,
            max_pending,
        } => json!({
            "type": "settings",
            "intervalMinutes": interval_minutes,
            "maxPerHour": max_per_hour,
            "maxPending": max_pending,
        }),
    };
    let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    std::fs::write(
        &temporary,
        format!("{}\n", crate::jsjson::stringify(&value)),
    )?;
    std::fs::rename(&temporary, &path)?;
    Ok(path)
}

pub fn parse_command(text: &str) -> Option<ScoutCommand> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    let object = parsed.as_object()?;
    match object.get("type")?.as_str()? {
        "stop" => Some(ScoutCommand::Stop),
        "drain" => Some(ScoutCommand::Drain),
        "refresh" => Some(ScoutCommand::Refresh),
        "settings" => {
            let interval_minutes = is_integer(object.get("intervalMinutes"))?;
            let parse_limit = |field: &str| -> Option<Option<i64>> {
                match object.get(field) {
                    Some(Value::Null) => Some(None),
                    Some(value) => Some(Some(value.as_i64()?)),
                    None => None,
                }
            };
            let max_per_hour = parse_limit("maxPerHour")?;
            let max_pending = parse_limit("maxPending")?;
            if !is_valid_cadence(interval_minutes)
                || !is_valid_limit(max_per_hour)
                || !is_valid_limit(max_pending)
            {
                return None;
            }
            Some(ScoutCommand::Settings {
                interval_minutes,
                max_per_hour,
                max_pending,
            })
        }
        _ => None,
    }
}

/// Reads and consumes every pending command in name order.
pub fn take_commands(directory: &Path) -> Vec<ScoutCommand> {
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
/* Lock                                                                      */
/* ------------------------------------------------------------------------ */

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LockOwner {
    #[serde(default)]
    pub repo: String,
    #[serde(default, rename = "stateDir")]
    pub state_dir: String,
    #[serde(default, rename = "harnessVersion")]
    pub harness_version: Option<String>,
    #[serde(default)]
    pub argv: Vec<String>,
    pub pid: u32,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    #[serde(default)]
    pub token: Option<String>,
}

#[derive(Debug, Clone)]
pub struct LockDetails {
    pub repo: String,
    pub state_dir: String,
    pub harness_version: Option<String>,
    pub argv: Vec<String>,
}

pub struct LockHandle {
    path: PathBuf,
    token: String,
}

impl LockHandle {
    pub fn release(self) {
        let _ = release_lock(&self.path, &self.token);
    }
}

pub enum LockResult {
    Acquired(LockHandle),
    Busy(Option<LockOwner>),
}

fn parse_lock(text: &str) -> Option<LockOwner> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    let object = parsed.as_object()?;
    let pid = is_integer(object.get("pid"))?;
    if pid <= 0 {
        return None;
    }
    let argv = object
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
    Some(LockOwner {
        repo: value_string(object.get("repo")).unwrap_or_default(),
        state_dir: value_string(object.get("stateDir")).unwrap_or_default(),
        harness_version: object
            .get("harnessVersion")
            .and_then(Value::as_str)
            .map(str::to_string),
        argv,
        pid: pid as u32,
        started_at: value_string(object.get("startedAt"))?,
        token: object
            .get("token")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

pub fn read_lock(path: &Path) -> Option<LockOwner> {
    parse_lock(crate::sampling::text(path)?.as_str())
}

fn process_started_at(pid: u32) -> Option<i64> {
    process_age_ms(pid).map(|age| now_millis() - age as i64)
}

fn owner_alive(owner: &LockOwner) -> bool {
    if !live_process(owner.pid) {
        return false;
    }
    let Some(recorded) = parse_iso_millis(&owner.started_at) else {
        return false;
    };
    match process_started_at(owner.pid) {
        Some(actual) => (actual - recorded).abs() as f64 <= START_TIME_TOLERANCE_MS,
        None => true,
    }
}

pub fn live_lock_owner(path: &Path) -> Option<LockOwner> {
    let owner = read_lock(path)?;
    owner_alive(&owner).then_some(owner)
}

fn own_started_at() -> String {
    iso_from_millis(process_started_at(std::process::id()).unwrap_or_else(now_millis))
}

fn release_lock(path: &Path, token: &str) -> std::io::Result<()> {
    let current = read_lock(path);
    match current {
        Some(owner) if owner.token.as_deref() == Some(token) => std::fs::remove_file(path),
        None => std::fs::remove_file(path),
        _ => Ok(()),
    }
}

/// Takes the lock, or reports the live owner. A lock whose owner is gone or
/// whose pid was recycled is reclaimed once.
pub fn acquire_lock(path: &Path, details: &LockDetails) -> LockResult {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let token = uuid::Uuid::new_v4().to_string();
    let owner = LockOwner {
        repo: details.repo.clone(),
        state_dir: details.state_dir.clone(),
        harness_version: details.harness_version.clone(),
        argv: details.argv.clone(),
        pid: std::process::id(),
        started_at: own_started_at(),
        token: Some(token.clone()),
    };
    let text = format!(
        "{}\n",
        crate::jsjson::stringify(&serde_json::to_value(&owner).unwrap_or(Value::Null))
    );
    for _attempt in 0..2 {
        let staged = PathBuf::from(format!(
            "{}.new-{}-{}",
            path.display(),
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let staged_result = (|| -> std::io::Result<()> {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staged)?;
            file.write_all(text.as_bytes())?;
            std::fs::hard_link(&staged, path)
        })();
        let _ = std::fs::remove_file(&staged);
        match staged_result {
            Ok(()) => {
                return LockResult::Acquired(LockHandle {
                    path: path.to_path_buf(),
                    token,
                })
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let Some(existing) = read_lock(path) else {
                    let _ = std::fs::remove_file(path);
                    continue;
                };
                if owner_alive(&existing) {
                    return LockResult::Busy(Some(existing));
                }
                let aside = PathBuf::from(format!(
                    "{}.reclaim-{}-{}",
                    path.display(),
                    std::process::id(),
                    uuid::Uuid::new_v4()
                ));
                if std::fs::rename(path, &aside).is_ok() {
                    let moved = read_lock(&aside);
                    let same = match (&moved, &existing) {
                        (Some(moved), existing) => moved.token == existing.token,
                        (None, _) => false,
                    };
                    if same {
                        let _ = std::fs::remove_file(&aside);
                    } else {
                        let _ = std::fs::hard_link(&aside, path);
                        let _ = std::fs::remove_file(&aside);
                    }
                }
            }
            Err(_) => return LockResult::Busy(None),
        }
    }
    LockResult::Busy(None)
}

/* ------------------------------------------------------------------------ */
/* Scan claim                                                                */
/* ------------------------------------------------------------------------ */

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoutScanClaim {
    pub pid: u32,
    pub started_at: String,
    pub harness_version: Option<String>,
    pub scan_id: Option<String>,
}

fn parse_claim(text: &str) -> Option<ScoutScanClaim> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    let object = parsed.as_object()?;
    let pid = is_integer(object.get("pid"))?;
    if pid <= 0 {
        return None;
    }
    let scan_id = match object.get("scanId")? {
        Value::Null => None,
        Value::String(value) => Some(value.clone()),
        _ => return None,
    };
    let harness_version = match object.get("harnessVersion")? {
        Value::Null => None,
        Value::String(value) => Some(value.clone()),
        _ => return None,
    };
    Some(ScoutScanClaim {
        pid: pid as u32,
        started_at: value_string(object.get("startedAt"))?,
        harness_version,
        scan_id,
    })
}

pub fn read_scan_claim(repo_dir: &Path) -> Option<ScoutScanClaim> {
    parse_claim(&std::fs::read_to_string(scan_claim_path(repo_dir)).ok()?)
}

pub fn live_scan_claim(repo_dir: &Path) -> Option<ScoutScanClaim> {
    let claim = read_scan_claim(repo_dir)?;
    if live_process(claim.pid) {
        return Some(claim);
    }
    clear_scan_claim(repo_dir, claim.pid);
    None
}

fn clear_scan_claim(repo_dir: &Path, pid: u32) {
    if let Some(existing) = read_scan_claim(repo_dir) {
        if existing.pid != pid {
            return;
        }
    }
    let _ = std::fs::remove_file(scan_claim_path(repo_dir));
}

/// Claims the repository's one scan slot; false means another live worker owns
/// it.
pub fn claim_scan(repo_dir: &Path, harness_version: Option<&str>, scan_id: Option<&str>) -> bool {
    let path = scan_claim_path(repo_dir);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let claim = ScoutScanClaim {
        pid: std::process::id(),
        started_at: iso_from_millis(now_millis()),
        harness_version: harness_version.map(str::to_string),
        scan_id: scan_id.map(str::to_string),
    };
    let text = format!(
        "{}\n",
        crate::jsjson::stringify(&serde_json::to_value(&claim).unwrap_or(Value::Null))
    );
    for _attempt in 0..2 {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                let _ = file.write_all(text.as_bytes());
                return true;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let Some(existing) = read_scan_claim(repo_dir) else {
                    let _ = std::fs::remove_file(&path);
                    continue;
                };
                if live_process(existing.pid) {
                    return false;
                }
                clear_scan_claim(repo_dir, existing.pid);
            }
            Err(_) => return false,
        }
    }
    false
}

pub fn update_scan_claim(repo_dir: &Path, scan_id: &str) {
    let Some(existing) = read_scan_claim(repo_dir) else {
        return;
    };
    if existing.pid != std::process::id() {
        return;
    }
    let mut updated = existing;
    updated.scan_id = Some(scan_id.to_string());
    let path = scan_claim_path(repo_dir);
    let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    let text = format!(
        "{}\n",
        crate::jsjson::stringify(&serde_json::to_value(&updated).unwrap_or(Value::Null))
    );
    if std::fs::write(&temporary, text).is_err() || std::fs::rename(&temporary, &path).is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
}

pub fn release_scan_claim(repo_dir: &Path) {
    let Some(existing) = read_scan_claim(repo_dir) else {
        return;
    };
    if existing.pid != std::process::id() {
        return;
    }
    let _ = std::fs::remove_file(scan_claim_path(repo_dir));
}

/* ------------------------------------------------------------------------ */
/* Capacity                                                                  */
/* ------------------------------------------------------------------------ */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScanCapacity {
    pub batch: i64,
    pub window_count: i64,
    pub open_count: i64,
    pub hourly_room: i64,
    pub pending_room: i64,
    pub blocked_until: Option<i64>,
}

/// The effective batch: how many issues this cycle may create. The hourly
/// window counts every Auto Scout issue created inside it, in any state.
pub fn scan_capacity(
    issues: &[ScoutIssueRow],
    limits: &ScoutLimits,
    now: i64,
    sync_ms: u64,
) -> ScanCapacity {
    let window_start = now - HOUR_MS;
    let mut window_count = 0i64;
    let mut oldest = i64::MAX;
    let mut open_count = 0i64;
    for issue in issues {
        if let Some(created_at) = parse_iso_millis(&issue.created_at) {
            if created_at > window_start {
                window_count += 1;
                if created_at < oldest {
                    oldest = created_at;
                }
            }
        }
        if issue.state == ScoutIssueState::Pending {
            open_count += 1;
        }
    }
    let hourly_room = match limits.max_per_hour {
        None => i64::MAX,
        Some(max) => (max - window_count).max(0),
    };
    let pending_room = match limits.max_pending {
        None => i64::MAX,
        Some(max) => (max - open_count).max(0),
    };
    let batch = hourly_room.min(pending_room);
    let mut blocked_until = None;
    if batch == 0 {
        let mut candidates: Vec<i64> = Vec::new();
        if pending_room == 0 {
            candidates.push(now + sync_ms as i64);
        }
        if hourly_room == 0 && oldest != i64::MAX {
            candidates.push(oldest + HOUR_MS);
        }
        if candidates.is_empty() {
            candidates.push(now + sync_ms as i64);
        }
        blocked_until = Some(*candidates.iter().min().unwrap_or(&now));
    }
    ScanCapacity {
        batch,
        window_count,
        open_count,
        hourly_room,
        pending_room,
        blocked_until,
    }
}

/* ------------------------------------------------------------------------ */
/* Entry point and request                                                   */
/* ------------------------------------------------------------------------ */

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntryPointPick {
    pub path: String,
    pub line: i64,
    pub surface: String,
    pub seed: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRequest {
    pub version: i64,
    pub scan_id: String,
    pub repository: String,
    pub repository_path: String,
    pub requested: i64,
    pub surface: String,
    pub seed: String,
    pub entry_point: EntryPointRef,
    pub categories: Vec<String>,
    pub excluded_roots: Vec<String>,
    pub draft_goal_headings: Vec<String>,
    pub significance_threshold: i64,
    pub max_per_hour: Option<i64>,
    pub max_pending: Option<i64>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EntryPointRef {
    pub path: String,
    pub line: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedScan {
    pub scan_id: String,
    pub directory: PathBuf,
    pub started_at: String,
}

const SKIPPED_DIRECTORIES: [&str; 5] = [".git", "node_modules", "dist", ".worktree", ".tmp"];
const SKIPPED_PREFIXES: [&str; 1] = [".devboard/.tmp"];
const EXCLUDED_TREES: [&str; 6] = [
    ".git",
    "node_modules",
    "dist",
    ".worktree",
    ".tmp",
    ".devboard/.tmp",
];

fn skipped(relative_path: &str) -> bool {
    let parts: Vec<&str> = relative_path.split('/').collect();
    if parts.iter().any(|part| SKIPPED_DIRECTORIES.contains(part)) {
        return true;
    }
    SKIPPED_PREFIXES
        .iter()
        .any(|prefix| relative_path == *prefix || relative_path.starts_with(&format!("{prefix}/")))
}

fn is_text_file(path: &Path) -> bool {
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    let sample = &bytes[..bytes.len().min(8192)];
    if sample.contains(&0) {
        return false;
    }
    let mut control = 0usize;
    let mut visible = false;
    for byte in sample {
        if *byte < 32 && !matches!(*byte, 9 | 10 | 13) {
            control += 1;
        }
        if *byte > 32 {
            visible = true;
        }
    }
    visible && !sample.is_empty() && (control as f64 / sample.len() as f64) < 0.1
}

fn git_work_tree(root: &Path) -> bool {
    let top = git(root, &["rev-parse", "--show-toplevel"]);
    if top.code != 0 {
        return false;
    }
    let Some(real) = std::fs::canonicalize(root).ok() else {
        return false;
    };
    std::fs::canonicalize(top.stdout.trim())
        .map(|top| top == real)
        .unwrap_or(false)
}

fn git_paths(root: &Path, args: &[&str]) -> Option<Vec<String>> {
    let result = git(root, args);
    if result.code != 0 {
        return None;
    }
    Some(
        result
            .stdout
            .split('\0')
            .filter(|entry| !entry.is_empty())
            .map(str::to_string)
            .collect(),
    )
}

/// The paths among `paths` that git itself excludes.
///
/// A tracked path is repository content even when a broad ignore rule matches
/// its text, so the check omits `--no-index`; only an untracked match is an
/// exclusion.
fn git_ignored_among(root: &Path, paths: &[String]) -> Option<HashSet<String>> {
    if paths.is_empty() {
        return Some(HashSet::new());
    }
    use std::io::Write as _;
    use std::process::{Command, Stdio};
    let mut child = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["check-ignore", "-z", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    if let Some(stdin) = child.stdin.as_mut() {
        for path in paths {
            if stdin.write_all(path.as_bytes()).is_err() || stdin.write_all(&[0]).is_err() {
                return None;
            }
        }
    }
    let output = child.wait_with_output().ok()?;
    let code = output.status.code()?;
    if code != 0 && code != 1 {
        return None;
    }
    Some(
        String::from_utf8_lossy(&output.stdout)
            .split('\0')
            .filter(|entry| !entry.is_empty())
            .map(str::to_string)
            .collect(),
    )
}

fn walk_regular_files(root: &Path) -> Vec<String> {
    fn visit(directory: &Path, prefix: &str, files: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(directory) else {
            return;
        };
        let mut children: Vec<std::fs::DirEntry> = entries.flatten().collect();
        children.sort_by(|left, right| {
            left.file_name()
                .to_string_lossy()
                .cmp(&right.file_name().to_string_lossy())
        });
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
                if skipped(&relative) {
                    continue;
                }
                visit(&entry.path(), &relative, files);
            } else if kind.is_file() && !skipped(&relative) {
                files.push(relative);
            }
        }
    }
    let mut files = Vec::new();
    visit(root, "", &mut files);
    files.sort();
    files
}

fn git_admitted_files(root: &Path) -> Option<Vec<String>> {
    let files = git_paths(
        root,
        &[
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ],
    )?;
    let ignored = git_ignored_among(root, &files)?;
    let mut admitted: Vec<String> = files
        .into_iter()
        .filter(|path| !skipped(path) && !ignored.contains(path))
        .collect();
    admitted.sort();
    Some(admitted)
}

fn scout_pool(root: &Path) -> Vec<String> {
    let files = if git_work_tree(root) {
        git_admitted_files(root).unwrap_or_else(|| walk_regular_files(root))
    } else {
        walk_regular_files(root)
    };
    let mut admitted: Vec<String> = files
        .into_iter()
        .filter(|path| !skipped(path))
        .filter(|path| is_text_file(&root.join(path)))
        .collect();
    admitted.sort();
    admitted
}

fn excluded_roots(root: &Path) -> Vec<String> {
    let mut roots: Vec<String> = EXCLUDED_TREES.iter().map(|root| root.to_string()).collect();
    let derived = if git_work_tree(root) {
        let mut trees: Vec<String> = git_paths(
            root,
            &[
                "ls-files",
                "-z",
                "--others",
                "--ignored",
                "--exclude-standard",
                "--directory",
            ],
        )
        .map(|paths| {
            paths
                .into_iter()
                .filter(|path| path.ends_with('/'))
                .map(|path| path.trim_end_matches('/').to_string())
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
        if let Some(candidates) = git_paths(
            root,
            &[
                "ls-files",
                "-z",
                "--cached",
                "--others",
                "--exclude-standard",
            ],
        ) {
            if let Some(ignored) = git_ignored_among(root, &candidates) {
                let mut parents: HashSet<String> = HashSet::new();
                for path in &ignored {
                    let segments: Vec<&str> = path.split('/').collect();
                    for length in 1..segments.len() {
                        parents.insert(segments[..length].join("/"));
                    }
                }
                let parent_list: Vec<String> = parents.into_iter().collect();
                if let Some(ignored_parents) = git_ignored_among(root, &parent_list) {
                    for parent in ignored_parents {
                        if !trees.contains(&parent) {
                            trees.push(parent);
                        }
                    }
                }
            }
        }
        trees.sort();
        trees
    } else {
        Vec::new()
    };
    for path in derived {
        if !roots.contains(&path) {
            roots.push(path);
        }
    }
    roots
}

/// One seeded entry-point pick for the scout surface.
pub fn pick_entry_point(repo_dir: &Path, seed: Option<&str>) -> Result<EntryPointPick, String> {
    let root = absolute(repo_dir);
    let canonical = std::fs::canonicalize(&root)
        .map_err(|_| format!("the repository root {} does not exist", root.display()))?;
    let files = scout_pool(&root);
    if files.is_empty() {
        return Err("the scout entry-point pool has no eligible file".to_string());
    }
    let seed = match seed.filter(|seed| !seed.is_empty()) {
        Some(seed) => seed.to_string(),
        None => {
            use rand::RngCore;
            let mut bytes = [0u8; 16];
            rand::thread_rng().fill_bytes(&mut bytes);
            hex::encode(bytes)
        }
    };
    let mut hasher = Sha256::new();
    hasher.update(format!("scout\u{0}{seed}").as_bytes());
    let hash = hasher.finalize();
    let first = u32::from_be_bytes([hash[0], hash[1], hash[2], hash[3]]) as usize;
    let path = files
        .get(first % files.len())
        .cloned()
        .ok_or_else(|| "the scout entry-point pool has no eligible file".to_string())?;
    let absolute_path = root.join(&path);
    let real = std::fs::canonicalize(&absolute_path)
        .map_err(|_| format!("the scout entry point {path} is not readable"))?;
    if !real.starts_with(&canonical) {
        return Err(format!(
            "the scout entry point resolves outside the repository: {path}"
        ));
    }
    let text = std::fs::read_to_string(&real)
        .map_err(|_| format!("the scout entry point {path} is not readable"))?;
    let body = text.strip_suffix('\n').unwrap_or(&text);
    let candidates: Vec<usize> = if body.is_empty() {
        Vec::new()
    } else {
        body.split('\n')
            .enumerate()
            .filter(|(_, line)| !line.trim().is_empty())
            .map(|(index, _)| index)
            .collect()
    };
    let Some(line) = candidates.get(
        u32::from_be_bytes([hash[4], hash[5], hash[6], hash[7]]) as usize % candidates.len().max(1),
    ) else {
        return Err(format!(
            "the entry point {path} has no non-blank line to name"
        ));
    };
    Ok(EntryPointPick {
        path,
        line: *line as i64 + 1,
        surface: "scout".to_string(),
        seed,
    })
}

/// The `# heading` of every draft under `<REPO_DIR>/.devboard/goal-proposals/`.
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

/// A UTC timestamp name, made unique when two scans start in one millisecond.
pub fn create_scan_directory(repo_dir: &Path, now: i64) -> Result<CreatedScan, String> {
    let base = scans_directory(repo_dir);
    std::fs::create_dir_all(&base)
        .map_err(|error| format!("could not create {}: {error}", base.display()))?;
    let stamp = run_identifier(now);
    for attempt in 0..100 {
        let scan_id = if attempt == 0 {
            stamp.clone()
        } else {
            format!("{stamp}-{attempt}")
        };
        let directory = scan_directory(repo_dir, &scan_id);
        match std::fs::create_dir(&directory) {
            Ok(()) => {
                return Ok(CreatedScan {
                    scan_id,
                    directory,
                    started_at: iso_from_millis(now),
                })
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "could not create a scan directory under {}: {error}",
                    base.display()
                ))
            }
        }
    }
    Err(format!(
        "could not create a scan directory under {}",
        base.display()
    ))
}

pub fn build_request(
    scan: &CreatedScan,
    repository: &str,
    repo_dir: &Path,
    requested: i64,
    draft_goal_headings: &[String],
    limits: &ScoutLimits,
    seed: Option<&str>,
) -> Result<ScanRequest, String> {
    let pick = pick_entry_point(repo_dir, seed)?;
    Ok(ScanRequest {
        version: 4,
        scan_id: scan.scan_id.clone(),
        repository: repository.to_string(),
        repository_path: absolute(repo_dir).to_string_lossy().into_owned(),
        requested,
        surface: pick.surface,
        seed: pick.seed,
        entry_point: EntryPointRef {
            path: pick.path,
            line: pick.line,
        },
        categories: CATEGORIES.iter().map(|value| value.to_string()).collect(),
        excluded_roots: excluded_roots(&absolute(repo_dir)),
        draft_goal_headings: draft_goal_headings.to_vec(),
        significance_threshold: SIGNIFICANCE_THRESHOLD,
        max_per_hour: limits.max_per_hour,
        max_pending: limits.max_pending,
        created_at: scan.started_at.clone(),
    })
}

pub fn write_request(directory: &Path, request: &ScanRequest) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(request)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    write_atomic(&request_path(directory), &format!("{text}\n"))
}

pub fn prompt_for(directory: &Path) -> String {
    format!("{SCAN_PROMPT} {}", directory.display())
}

/* ------------------------------------------------------------------------ */
/* Forge reads                                                               */
/* ------------------------------------------------------------------------ */

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScoutForgeIssue {
    pub number: i64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub created_at: String,
    pub closed_at: Option<String>,
    pub body: String,
}

pub type ForgeFuture<T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'static>>;

/// The forge facts Auto Scout reads. An injected implementation is the test
/// seam; production reads the origin through `gh` or the Gitea API.
pub trait ScoutForge: Send + Sync {
    fn list_issues(&self) -> ForgeFuture<Vec<ScoutForgeIssue>>;
    fn list_open_issue_titles(&self) -> ForgeFuture<Vec<String>>;
    fn list_releases(&self) -> ForgeFuture<Vec<GitHubRelease>>;
    fn closing_client(&self) -> &dyn ClosingCommitClient;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitHubRead {
    pub issues: Vec<ScoutForgeIssue>,
    pub releases: Vec<GitHubRelease>,
    pub open_titles: Vec<String>,
}

fn first_line(text: &str) -> String {
    text.split('\n')
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("no diagnostic")
        .to_string()
}

pub fn is_github_rate_limited(text: &str) -> bool {
    classify_forge_read_failure(text) == ForgeReadFailureKind::RateLimit
}

/// The `## Category` line of an issue body, or null.
pub fn category_from_body(body: &str) -> Option<String> {
    let lines: Vec<&str> = body.split('\n').collect();
    let heading = lines
        .iter()
        .position(|line| line.trim().to_lowercase() == "## category")?;
    for line in &lines[heading + 1..] {
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

fn graceful_command_output(
    argv: &[String],
    environment: &HashMap<String, String>,
    timeout_ms: u64,
) -> Pin<Box<dyn Future<Output = (i32, String, String)> + Send>> {
    let argv: Vec<String> = argv.to_vec();
    let environment = environment.clone();
    Box::pin(async move {
        let mut command = tokio::process::Command::new("gh");
        command
            .args(&argv)
            .env_clear()
            .envs(&environment)
            .env("GH_PROMPT_DISABLED", "1")
            .env("GH_NO_UPDATE_NOTIFIER", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("NO_COLOR", "1")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        match tokio::time::timeout(Duration::from_millis(timeout_ms.max(1)), command.output()).await
        {
            Ok(Ok(output)) => (
                output.status.code().unwrap_or(1),
                String::from_utf8_lossy(&output.stdout).into_owned(),
                String::from_utf8_lossy(&output.stderr).into_owned(),
            ),
            Ok(Err(error)) => (1, String::new(), error.to_string()),
            Err(_) => (
                1,
                String::new(),
                "the command did not finish before its deadline".to_string(),
            ),
        }
    })
}

pub struct GitHubScoutForge {
    repository: String,
    environment: HashMap<String, String>,
    timeout_ms: u64,
    github: RepositoryGitHub,
}

impl GitHubScoutForge {
    pub fn new(
        repository: impl Into<String>,
        repo_dir: PathBuf,
        environment: HashMap<String, String>,
        timeout_ms: u64,
    ) -> Self {
        let repository = repository.into();
        let runner_environment = environment.clone();
        let runner: Arc<
            dyn Fn(Vec<String>, HashMap<String, String>) -> crate::forge::GitHubCommandFuture
                + Send
                + Sync,
        > = Arc::new(move |argv, _bound| {
            let environment = runner_environment.clone();
            let future = graceful_command_output(&argv, &environment, timeout_ms);
            Box::pin(async move {
                let (code, stdout, stderr) = future.await;
                crate::forge::GitHubCommandOutcome {
                    code,
                    stdout,
                    stderr,
                }
            })
        });
        let github = RepositoryGitHub::new(RepositoryGitHubOptions {
            repository: repository.clone(),
            repo_dir: repo_dir.clone(),
            run: runner,
            environment: environment.clone(),
        });
        Self {
            repository,
            environment,
            timeout_ms,
            github,
        }
    }
}

fn parse_json_entries(text: &str) -> Option<Vec<Value>> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    parsed.as_array().cloned()
}

impl ScoutForge for GitHubScoutForge {
    fn list_issues(&self) -> ForgeFuture<Vec<ScoutForgeIssue>> {
        let argv = vec![
            "issue".to_string(),
            "list".to_string(),
            "--repo".to_string(),
            self.repository.clone(),
            "--label".to_string(),
            SCOUT_LABEL.to_string(),
            "--state".to_string(),
            "all".to_string(),
            "--limit".to_string(),
            "1000".to_string(),
            "--json".to_string(),
            "number,title,url,state,createdAt,closedAt,body".to_string(),
        ];
        let environment = self.environment.clone();
        let timeout_ms = self.timeout_ms;
        Box::pin(async move {
            let (code, stdout, stderr) =
                graceful_command_output(&argv, &environment, timeout_ms).await;
            if code != 0 {
                return Err(first_line(&stderr));
            }
            let Some(entries) = parse_json_entries(&stdout) else {
                return Err("gh issue list did not print a JSON array".to_string());
            };
            let mut issues = Vec::new();
            let mut seen = HashSet::new();
            for entry in entries {
                let Some(object) = entry.as_object() else {
                    continue;
                };
                let Some(number) = object.get("number").and_then(Value::as_i64) else {
                    continue;
                };
                let (Some(title), Some(url), Some(created_at), Some(body), Some(state)) = (
                    object.get("title").and_then(Value::as_str),
                    object.get("url").and_then(Value::as_str),
                    object.get("createdAt").and_then(Value::as_str),
                    object.get("body").and_then(Value::as_str),
                    object.get("state").and_then(Value::as_str),
                ) else {
                    continue;
                };
                if !seen.insert(number) {
                    continue;
                }
                issues.push(ScoutForgeIssue {
                    number,
                    title: title.to_string(),
                    url: url.to_string(),
                    state: if state.to_lowercase() == "closed" {
                        "closed".to_string()
                    } else {
                        "open".to_string()
                    },
                    created_at: created_at.to_string(),
                    closed_at: object
                        .get("closedAt")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string),
                    body: body.to_string(),
                });
            }
            Ok(issues)
        })
    }

    fn list_open_issue_titles(&self) -> ForgeFuture<Vec<String>> {
        let argv = vec![
            "issue".to_string(),
            "list".to_string(),
            "--repo".to_string(),
            self.repository.clone(),
            "--state".to_string(),
            "open".to_string(),
            "--limit".to_string(),
            "1000".to_string(),
            "--json".to_string(),
            "title".to_string(),
        ];
        let environment = self.environment.clone();
        let timeout_ms = self.timeout_ms;
        Box::pin(async move {
            let (code, stdout, stderr) =
                graceful_command_output(&argv, &environment, timeout_ms).await;
            if code != 0 {
                return Err(first_line(&stderr));
            }
            let Some(entries) = parse_json_entries(&stdout) else {
                return Err("gh issue list did not print a JSON array".to_string());
            };
            Ok(entries
                .into_iter()
                .filter_map(|entry| {
                    entry
                        .get("title")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .collect())
        })
    }

    fn list_releases(&self) -> ForgeFuture<Vec<GitHubRelease>> {
        let github = self.github.clone();
        Box::pin(async move { github.list_releases().await })
    }

    fn closing_client(&self) -> &dyn ClosingCommitClient {
        &self.github
    }
}

pub struct GiteaScoutForge {
    target: crate::forge::GiteaTarget,
    transport: crate::forge::Transport,
    options: crate::forge::GiteaCallOptions,
    version: GiteaVersionClient,
}

pub struct GiteaVersionClient {
    target: crate::forge::GiteaTarget,
    repo_dir: PathBuf,
    transport: crate::forge::Transport,
    options: crate::forge::GiteaCallOptions,
}

fn encode_uri_component(value: &str) -> String {
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

impl GiteaScoutForge {
    pub fn new(target: crate::forge::GiteaTarget, repo_dir: PathBuf, timeout_ms: u64) -> Self {
        let transport = crate::forge::default_transport(timeout_ms);
        let options = crate::forge::GiteaCallOptions {
            flow_id: None,
            timeout_ms: Some(timeout_ms),
        };
        let version = GiteaVersionClient {
            target: target.clone(),
            repo_dir: repo_dir.clone(),
            transport: transport.clone(),
            options: options.clone(),
        };
        let _ = &repo_dir;
        Self {
            target,
            transport,
            options,
            version,
        }
    }
}

impl ScoutForge for GiteaScoutForge {
    fn list_issues(&self) -> ForgeFuture<Vec<ScoutForgeIssue>> {
        let target = self.target.clone();
        let transport = self.transport.clone();
        let options = self.options.clone();
        Box::pin(async move {
            let issues = gitea_list_labelled_issues(
                &target,
                IssueQueryState::All,
                SCOUT_LABEL,
                &transport,
                &options,
            )
            .await
            .map_err(|error| error.message)?;
            Ok(issues
                .into_iter()
                .filter(|issue| issue.labels.iter().any(|label| label == SCOUT_LABEL))
                .map(|issue| ScoutForgeIssue {
                    number: issue.number,
                    title: issue.title,
                    url: issue.url,
                    state: issue.state.as_str().to_string(),
                    created_at: issue.created_at,
                    closed_at: issue.closed_at,
                    body: issue.body,
                })
                .collect())
        })
    }

    fn list_open_issue_titles(&self) -> ForgeFuture<Vec<String>> {
        let target = self.target.clone();
        let transport = self.transport.clone();
        let options = self.options.clone();
        Box::pin(async move {
            let issues = gitea_list_issues(&target, IssueQueryState::Open, &transport, &options)
                .await
                .map_err(|error| error.message)?;
            Ok(issues.into_iter().map(|issue| issue.title).collect())
        })
    }

    fn list_releases(&self) -> ForgeFuture<Vec<GitHubRelease>> {
        let target = self.target.clone();
        let transport = self.transport.clone();
        let options = self.options.clone();
        Box::pin(async move {
            let releases = gitea_list_releases(&target, &transport, &options)
                .await
                .map_err(|error| error.message)?;
            Ok(releases
                .into_iter()
                .map(|release| GitHubRelease {
                    tag: release.tag,
                    published_at: release.published_at,
                })
                .collect())
        })
    }

    fn closing_client(&self) -> &dyn ClosingCommitClient {
        &self.version
    }
}

impl ClosingCommitClient for GiteaVersionClient {
    fn closing_commit(&self, issue_number: i64) -> crate::forge::ClientFuture<'_, Option<String>> {
        Box::pin(async move {
            gitea_closing_commits(&self.target, issue_number, &self.transport, &self.options)
                .await
                .map(|commits| commits.into_iter().next())
                .map_err(|error| error.message)
        })
    }

    fn closing_commits(&self, issue_number: i64) -> crate::forge::ClientFuture<'_, Vec<String>> {
        Box::pin(async move {
            gitea_closing_commits(&self.target, issue_number, &self.transport, &self.options)
                .await
                .map_err(|error| error.message)
        })
    }

    fn landed_commits(&self, issue_number: i64) -> Vec<String> {
        crate::forge::landed_commits(&self.repo_dir, issue_number)
    }

    fn resolve_commit(&self, short: String) -> crate::forge::ClientFuture<'_, Option<String>> {
        Box::pin(async move {
            if !crate::forge::is_sha(&short) {
                return Ok(None);
            }
            let local = git(
                &self.repo_dir,
                &[
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    &format!("{short}^{{commit}}"),
                ],
            );
            if local.code == 0 {
                let sha = local.stdout.split_whitespace().next().unwrap_or("");
                if crate::forge::is_full_sha(sha) {
                    return Ok(Some(sha.to_string()));
                }
            }
            let path = format!(
                "{}/git/commits/{}",
                crate::forge::repo_path(&self.target),
                encode_uri_component(&short)
            );
            match gitea_json(&self.target, &path, None, &self.transport, &self.options).await {
                Ok(value) => Ok(value
                    .get("sha")
                    .and_then(Value::as_str)
                    .filter(|sha| crate::forge::is_full_sha(sha))
                    .map(str::to_string)),
                Err(error) if matches!(error.status, Some(404) | Some(422)) => Ok(None),
                Err(error) => Err(error.message),
            }
        })
    }

    fn containing_release_tags(
        &self,
        commit: String,
        releases: Vec<GitHubRelease>,
    ) -> crate::forge::ClientFuture<'_, Vec<String>> {
        Box::pin(async move {
            let containment = local_release_containment(&self.repo_dir, &commit, &releases);
            if containment.pending.is_empty() {
                return Ok(containment.contained);
            }
            let mut contained = containment.contained;
            for release in containment.pending {
                let path = format!(
                    "{}/compare/{}...{}",
                    crate::forge::repo_path(&self.target),
                    encode_uri_component(&release.tag),
                    encode_uri_component(&commit)
                );
                let Ok(value) =
                    gitea_json(&self.target, &path, None, &self.transport, &self.options).await
                else {
                    continue;
                };
                if value.get("total_commits").and_then(Value::as_i64) == Some(0) {
                    contained.push(release.tag);
                }
            }
            Ok(contained)
        })
    }
}

struct LocalReleaseContainment {
    contained: Vec<String>,
    pending: Vec<GitHubRelease>,
}

fn tag_names(output: &str) -> HashSet<String> {
    output
        .split('\n')
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

fn local_release_containment(
    repo_dir: &Path,
    commit: &str,
    releases: &[GitHubRelease],
) -> LocalReleaseContainment {
    let listed = git(repo_dir, &["tag", "--list"]);
    let containing = git(repo_dir, &["tag", "--contains", commit]);
    let present = if listed.code == 0 {
        tag_names(&listed.stdout)
    } else {
        HashSet::new()
    };
    let named = (containing.code == 0).then(|| tag_names(&containing.stdout));
    let mut contained = Vec::new();
    let mut pending = Vec::new();
    for release in releases {
        if !present.contains(&release.tag) || named.is_none() {
            pending.push(release.clone());
        } else if named
            .as_ref()
            .is_some_and(|named| named.contains(&release.tag))
        {
            contained.push(release.tag.clone());
        }
    }
    LocalReleaseContainment { pending, contained }
}

/* ------------------------------------------------------------------------ */
/* The agent                                                                 */
/* ------------------------------------------------------------------------ */

pub struct ScanAgentContext {
    pub command: String,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
    pub prompt: String,
    pub directory: PathBuf,
    pub activity: Arc<dyn Fn(AcpActivity) + Send + Sync>,
    pub update: Arc<dyn Fn() + Send + Sync>,
    pub stderr: Arc<dyn Fn(&str) + Send + Sync>,
    pub child: Arc<Mutex<Option<ScoutAcpChild>>>,
    pub child_recorded: Arc<dyn Fn(ScoutAcpChild) + Send + Sync>,
    pub started: Arc<dyn Fn() + Send + Sync>,
}

pub type ScanAgentFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;
pub type ScanAgent = Arc<dyn Fn(ScanAgentContext) -> ScanAgentFuture + Send + Sync>;

/// The production agent: one ACP peer whose callbacks become activity, timer
/// resets, question answers, and the recorded child.
pub fn default_scan_agent() -> ScanAgent {
    Arc::new(|context: ScanAgentContext| {
        Box::pin(async move {
            let options =
                AcpConnectionOptions::new(context.command.clone(), context.cwd.to_string_lossy())
                    .with_starter("Auto Scout")
                    .with_env(context.env.clone());
            let (connection, mut receiver) = AcpConnection::connect(options)
                .await
                .map_err(|error| error.message)?;
            (context.started)();
            if let Some(pid) = connection.pid() {
                let argv = process_argv(pid).unwrap_or_else(|| connection.argv());
                let child = ScoutAcpChild {
                    pid,
                    argv,
                    cwd: context.cwd.to_string_lossy().into_owned(),
                };
                if let Ok(mut slot) = context.child.lock() {
                    *slot = Some(child.clone());
                }
                (context.child_recorded)(child);
            }
            let run = connection.run(&context.prompt);
            tokio::pin!(run);
            loop {
                tokio::select! {
                    result = &mut run => {
                        connection.close();
                        return result.map(|_| ()).map_err(|error| error.message);
                    }
                    event = receiver.recv() => {
                        let Some(event) = event else { continue };
                        match event {
                            AcpEvent::Activity(activity) => (context.activity)(activity),
                            AcpEvent::SessionUpdate => (context.update)(),
                            AcpEvent::Stderr(text) => (context.stderr)(&text),
                            AcpEvent::Text(_) => {}
                            AcpEvent::Question(question) => {
                                (context.activity)(AcpActivity {
                                    text: format!("question: {}", question.message),
                                    append: false,
                                });
                                let option = question
                                    .options
                                    .iter()
                                    .find(|option| option.recommended)
                                    .or_else(|| question.options.first());
                                let value = option.map(|option| option.label.clone()).unwrap_or_default();
                                let answered = connection.answer(&question.id, &value).await;
                                (context.activity)(AcpActivity {
                                    text: format!(
                                        "answer: {}",
                                        if answered {
                                            if value.is_empty() {
                                                "(no options offered)".to_string()
                                            } else {
                                                value
                                            }
                                        } else {
                                            "failed".to_string()
                                        }
                                    ),
                                    append: false,
                                });
                            }
                        }
                    }
                }
            }
        })
    })
}

/* ------------------------------------------------------------------------ */
/* The worker                                                                */
/* ------------------------------------------------------------------------ */

struct ActiveShared {
    activity: Vec<String>,
    first_line: Option<String>,
    finished: bool,
    last_activity_ms: i64,
    filed: i64,
    filed_numbers: Vec<i64>,
    settle: Option<SettleShared>,
    child: Arc<Mutex<Option<ScoutAcpChild>>>,
    started: bool,
}

struct SettleShared {
    finished: bool,
}

struct ActiveScan {
    scan_id: String,
    directory: PathBuf,
    requested: i64,
    prompt: String,
    started_at: String,
    shared: Arc<Mutex<ActiveShared>>,
    join: Option<tokio::task::JoinHandle<ScanCompletion>>,
    abort: tokio::task::AbortHandle,
}

impl ActiveScan {
    fn is_filing(&self) -> bool {
        lock_unpoisoned(&self.shared).settle.is_some()
    }
}

struct ScanCompletion {
    scan_id: String,
    read: Option<ReadPatch>,
    sync_failure: Option<String>,
    notice: Option<String>,
    error: Option<String>,
    /// The first refused `issue_create`: it stays on the record and in
    /// `last_error`, and never fails a scan whose status the count decides.
    filing_error: Option<String>,
    start_failure: bool,
}

#[derive(Debug, Clone)]
struct ReadPatch {
    issues: Vec<ScoutIssueRow>,
    release_signature: String,
    open_titles: Vec<String>,
}

struct Runtime {
    state: ScoutState,
    github: Arc<dyn ScoutForge>,
    active: Option<ActiveScan>,
    starting: bool,
    stopping: bool,
    draining: bool,
    lease_held: bool,
    consuming: bool,
    syncing: bool,
    retry: ForgeReadRetry,
    open_titles: Vec<String>,
    lock: Option<LockHandle>,
    last_saved: String,
    next_sync_at: i64,
}

#[derive(Clone)]
pub struct ScoutWorkerOptions {
    pub repo_dir: PathBuf,
    pub state_dir: PathBuf,
    pub harness_version: Option<String>,
    pub environment: Option<HashMap<String, String>>,
    pub agent_command: Option<String>,
    pub sync_ms: Option<u64>,
    pub read_timeout_ms: Option<u64>,
    pub timeout_ms: Option<i64>,
    pub tick_ms: Option<u64>,
    pub cadence_ms: Option<u64>,
    pub now: Option<Clock>,
    pub forge: Option<Arc<dyn ScoutForge>>,
    pub agent: Option<ScanAgent>,
    pub log: Option<LogFn>,
}

impl ScoutWorkerOptions {
    pub fn new(repo_dir: impl Into<PathBuf>, state_dir: impl Into<PathBuf>) -> Self {
        Self {
            repo_dir: repo_dir.into(),
            state_dir: state_dir.into(),
            harness_version: None,
            environment: None,
            agent_command: None,
            sync_ms: None,
            read_timeout_ms: None,
            timeout_ms: None,
            tick_ms: None,
            cadence_ms: None,
            now: None,
            forge: None,
            agent: None,
            log: None,
        }
    }
}

pub struct ScoutWorker {
    repo_dir: PathBuf,
    state_dir: PathBuf,
    harness_version: Option<String>,
    environment: HashMap<String, String>,
    agent_command: String,
    agent: ScanAgent,
    clock: Clock,
    log: LogFn,
    sync_ms: u64,
    read_timeout_ms: u64,
    timeout_ms: i64,
    tick_ms: u64,
    cadence_override_ms: Option<u64>,
    injected_github: Option<Arc<dyn ScoutForge>>,
    provider_environment: Arc<crate::providers::WorkerProviderEnvironment>,
    syncing_flag: Arc<AtomicBool>,
    runtime: Arc<Mutex<Runtime>>,
}

impl ScoutWorker {
    pub fn new(options: ScoutWorkerOptions) -> Self {
        let repo_dir = absolute(options.repo_dir);
        let state_dir = absolute(options.state_dir);
        let environment: HashMap<String, String> = options
            .environment
            .unwrap_or_else(|| std::env::vars().collect());
        let harness_version = options.harness_version.or_else(|| {
            environment
                .get("DEVBOARD_HARNESS_VERSION")
                .filter(|value| !value.is_empty())
                .cloned()
                .or_else(|| read_harness_version(&repo_dir.join(".devboard")))
        });
        let clock: Clock = options.now.unwrap_or_else(|| Arc::new(now_millis));
        let agent_command = options
            .agent_command
            .or_else(|| environment.get("AGENT_COMMAND").cloned())
            .unwrap_or_else(|| "omp acp".to_string());
        let now = (clock)();
        let provider_environment = Arc::new(create_worker_provider_environment(
            &state_dir,
            &repo_dir,
            environment
                .iter()
                .map(|(key, value)| (key.clone(), Some(value.clone())))
                .collect(),
            ProviderOptions::default(),
        ));
        let runtime = Runtime {
            state: empty_state("", &repo_dir, now),
            github: Arc::new(NullForge),
            active: None,
            starting: false,
            stopping: false,
            draining: false,
            lease_held: false,
            consuming: false,
            syncing: false,
            retry: ForgeReadRetry::default(),
            open_titles: Vec::new(),
            lock: None,
            last_saved: String::new(),
            next_sync_at: 0,
        };
        Self {
            repo_dir,
            state_dir,
            harness_version,
            environment,
            agent_command,
            agent: options.agent.unwrap_or_else(default_scan_agent),
            clock,
            log: options.log.unwrap_or_else(|| Arc::new(|_line: &str| {})),
            sync_ms: options.sync_ms.unwrap_or(SYNC_INTERVAL_MS).max(MIN_SYNC_MS),
            read_timeout_ms: options.read_timeout_ms.unwrap_or(READ_TIMEOUT_MS).max(1),
            timeout_ms: options.timeout_ms.unwrap_or(SCAN_TIMEOUT_MS).max(1000),
            tick_ms: options.tick_ms.unwrap_or(TICK_MS).max(1),
            cadence_override_ms: options.cadence_ms,
            injected_github: options.forge,
            provider_environment,
            syncing_flag: Arc::new(AtomicBool::new(false)),
            runtime: Arc::new(Mutex::new(runtime)),
        }
    }

    pub fn repo_dir(&self) -> &Path {
        &self.repo_dir
    }

    pub fn state_dir(&self) -> &Path {
        &self.state_dir
    }

    pub fn harness_version(&self) -> Option<&str> {
        self.harness_version.as_deref()
    }

    pub fn current_state(&self) -> ScoutState {
        lock_unpoisoned(&self.runtime).state.clone()
    }

    pub fn scanning(&self) -> bool {
        lock_unpoisoned(&self.runtime).active.is_some()
    }

    pub fn settings(&self) -> ScoutSettings {
        let state = &lock_unpoisoned(&self.runtime).state;
        ScoutSettings {
            max_per_hour: state.limits.max_per_hour,
            max_pending: state.limits.max_pending,
            interval_minutes: state.interval_minutes,
        }
    }

    fn versioned_state_path(&self) -> PathBuf {
        versioned_state_path(
            &self.state_dir,
            &self.repo_dir,
            self.harness_version.as_deref(),
        )
    }

    fn lock_details(&self) -> LockDetails {
        LockDetails {
            repo: self.repo_dir.to_string_lossy().into_owned(),
            state_dir: self.state_dir.to_string_lossy().into_owned(),
            harness_version: self.harness_version.clone(),
            argv: std::env::args().collect(),
        }
    }

    /// Takes the repository lock and publishes a fresh `idle` cycle.
    pub fn start(&self, repository: &str) -> bool {
        let lock = match acquire_lock(
            &version_lock_path(&lock_path(&self.repo_dir), self.harness_version.as_deref()),
            &self.lock_details(),
        ) {
            LockResult::Acquired(lock) => lock,
            LockResult::Busy(_) => {
                (self.log)(&format!("already running for {}", self.repo_dir.display()));
                return false;
            }
        };
        let previous = inherited_state_path(
            &self.versioned_state_path(),
            &versioned_state_files(&worker_state_directories(&self.state_dir, &self.repo_dir)),
            &state_path(&self.state_dir, &self.repo_dir),
        )
        .and_then(|path| load_state(&path));
        let now = (self.clock)();
        let owned_by_this_version = match &previous {
            None => true,
            Some(previous) => match &previous.worker {
                None => true,
                Some(worker) => {
                    worker.harness_version == self.harness_version || !live_process(worker.pid)
                }
            },
        };
        // A scan the previous worker left `running` is closed as the interruption it was. It
        // never becomes this worker's last error: the new worker started no scan and failed
        // nothing, and the process that owns this state has no way to act on a scan it did not
        // start. Only an error this worker records raises the page's error alert.
        if let Some(previous) = &previous {
            if let Some(scan) = &previous.scan {
                if owned_by_this_version {
                    self.close_interrupted_scan(&scan.scan_id);
                }
            }
        }
        let settings = read_settings(&settings_path(&self.state_dir, &self.repo_dir))
            .unwrap_or_else(|| {
                let (max_per_hour, max_pending) = match previous.as_ref() {
                    Some(state) => (state.limits.max_per_hour, state.limits.max_pending),
                    None => (Some(DEFAULT_MAX_PER_HOUR), Some(DEFAULT_MAX_PENDING)),
                };
                ScoutSettings {
                    max_per_hour,
                    max_pending,
                    interval_minutes: previous
                        .as_ref()
                        .map(|state| state.interval_minutes)
                        .unwrap_or(DEFAULT_INTERVAL_MINUTES),
                }
            });
        let mut state = empty_state(repository, &self.repo_dir, now);
        state.lifecycle = ScoutLifecycle::Idle.as_str().to_string();
        state.enabled = true;
        state.worker = Some(ScoutWorkerRecord {
            pid: std::process::id(),
            start_ticks: crate::supervision::start_ticks(std::process::id()),
            started_at: iso_from_millis(now),
            state_dir: self.state_dir.to_string_lossy().into_owned(),
            harness_version: self.harness_version.clone(),
            argv: std::env::args().collect(),
        });
        state.limits = ScoutLimits {
            max_per_hour: settings.max_per_hour,
            max_pending: settings.max_pending,
        };
        state.interval_minutes = settings.interval_minutes;
        state.last_scan_started_at = previous
            .as_ref()
            .and_then(|state| state.last_scan_started_at.clone());
        state.issues = previous
            .as_ref()
            .map(|state| state.issues.clone())
            .unwrap_or_default();
        state.open_titles = previous
            .as_ref()
            .map(|state| state.open_titles.clone())
            .unwrap_or_default();
        state.release_signature = previous
            .as_ref()
            .and_then(|state| state.release_signature.clone());
        state.sync = previous
            .as_ref()
            .map(|state| state.sync.clone())
            .unwrap_or_default();
        state.newest_scan_id = previous
            .as_ref()
            .and_then(|state| state.newest_scan_id.clone());
        state.notice = previous.as_ref().and_then(|state| state.notice.clone());
        state.updated_at = iso_from_millis(now);

        let github = match &self.injected_github {
            Some(github) => Arc::clone(github),
            None => match self.production_forge(repository) {
                Ok(github) => github,
                Err(error) => {
                    (self.log)(&error);
                    lock.release();
                    return false;
                }
            },
        };
        let mut runtime = lock_unpoisoned(&self.runtime);
        runtime.open_titles = state.open_titles.clone();
        runtime.state = state;
        runtime.github = github;
        runtime.lock = Some(lock);
        runtime.next_sync_at = 0;
        runtime.last_saved = String::new();
        self.publish_locked(&mut runtime);
        true
    }

    fn production_forge(&self, repository: &str) -> Result<Arc<dyn ScoutForge>, String> {
        let remote = origin_forge_with(&self.repo_dir, &self.environment);
        match remote {
            Some(remote) if remote.forge == Forge::Gitea => {
                let target = crate::forge::gitea_target(
                    Some(&remote),
                    Some(repository),
                    None,
                    None,
                    &self.environment,
                )
                .map_err(|error| error.message)?;
                Ok(Arc::new(GiteaScoutForge::new(
                    target,
                    self.repo_dir.clone(),
                    self.read_timeout_ms,
                )))
            }
            Some(remote) if remote.forge == Forge::GitLab => Err(format!(
                "the scout supports a GitHub or Gitea origin, not a GitLab one: {}",
                remote.host
            )),
            Some(_) => Ok(Arc::new(GitHubScoutForge::new(
                repository,
                self.repo_dir.clone(),
                self.environment.clone(),
                self.read_timeout_ms,
            ))),
            // An origin that names no supported forge reads and files nothing:
            // the refusal names the origin instead of selecting GitHub.
            None => Err(
                crate::forge::origin_problem(&self.repo_dir, &self.environment).unwrap_or_else(
                    || "the checkout's origin does not name a supported repository".to_string(),
                ),
            ),
        }
    }

    /// A scan interrupted by a dead worker is closed, never left `running`.
    fn close_interrupted_scan(&self, scan_id: &str) {
        let directory = scan_directory(&self.repo_dir, scan_id);
        let Some(scan) = read_scan_file(&directory) else {
            return;
        };
        if scan.status != "running" {
            return;
        }
        if let Some(acp) = &scan.acp {
            if live_process(acp.pid) && process_argv(acp.pid).is_some_and(|argv| argv == acp.argv) {
                #[cfg(unix)]
                unsafe {
                    libc::kill(acp.pid as i32, libc::SIGKILL);
                }
                (self.log)(&format!("terminated orphaned ACP child {}", acp.pid));
            }
        }
        let mut failed = scan;
        failed.status = "failed".to_string();
        failed.finished_at = Some(iso_from_millis((self.clock)()));
        failed.error = Some("the worker that owned this scan exited".to_string());
        let _ = write_scan_file(&directory, &failed);
    }

    fn publish_locked(&self, runtime: &mut Runtime) {
        runtime.state.updated_at = iso_from_millis((self.clock)());
        let text = match serde_json::to_string(&runtime.state) {
            Ok(text) => text,
            Err(error) => {
                (self.log)(&format!("could not write state: {error}"));
                return;
            }
        };
        if text == runtime.last_saved {
            return;
        }
        if let Err(error) = write_state(&self.versioned_state_path(), &runtime.state) {
            (self.log)(&format!("could not write state: {error}"));
            return;
        }
        runtime.last_saved = text;
    }

    fn cadence_ms(&self) -> i64 {
        match self.cadence_override_ms {
            Some(value) => value as i64,
            None => lock_unpoisoned(&self.runtime).state.interval_minutes * 60_000,
        }
    }

    fn cadence_remaining(&self, now: i64) -> bool {
        // The anchor is read under the lock and the cadence after it is released:
        // `cadence_ms` takes the same mutex, so holding it here would deadlock the
        // tick that follows a recorded run.
        let last_scan_started_at = lock_unpoisoned(&self.runtime)
            .state
            .last_scan_started_at
            .clone();
        let Some(started) = last_scan_started_at.as_deref().and_then(parse_iso_millis) else {
            return false;
        };
        now < started + self.cadence_ms()
    }

    fn cooldown_remaining(&self, now: i64) -> bool {
        let runtime = lock_unpoisoned(&self.runtime);
        runtime
            .state
            .next_attempt_at
            .as_deref()
            .and_then(parse_iso_millis)
            .is_some_and(|until| now < until)
    }

    fn block(&self, until: Option<String>) {
        let mut runtime = lock_unpoisoned(&self.runtime);
        if runtime.state.next_attempt_at == until {
            return;
        }
        runtime.state.next_attempt_at = until;
        self.publish_locked(&mut runtime);
    }

    fn mark_stale(&self) {
        let mut runtime = lock_unpoisoned(&self.runtime);
        if runtime.state.sync.state != "ok" {
            return;
        }
        let Some(at) = runtime.state.sync.at.clone() else {
            return;
        };
        let Some(last) = parse_iso_millis(&at) else {
            return;
        };
        if (self.clock)() - last <= 2 * self.sync_ms as i64 {
            return;
        }
        runtime.state.sync = ScoutSync {
            state: "stale".to_string(),
            at: Some(at),
            error: Some(format!(
                "no forge read has succeeded for more than {} seconds",
                ((2 * self.sync_ms) as f64 / 1000.0).round() as i64
            )),
        };
        self.publish_locked(&mut runtime);
    }

    /* -------------------------------------------------------------------- */
    /* Commands                                                              */
    /* -------------------------------------------------------------------- */

    pub async fn consume_commands(&self) {
        {
            let mut runtime = lock_unpoisoned(&self.runtime);
            if runtime.consuming {
                return;
            }
            runtime.consuming = true;
        }
        let mut commands = take_commands(&versioned_control_directory(
            &self.state_dir,
            &self.repo_dir,
            self.harness_version.as_deref(),
        ));
        commands.extend(take_commands(&control_directory(
            &self.state_dir,
            &self.repo_dir,
        )));
        for command in commands {
            if lock_unpoisoned(&self.runtime).stopping {
                break;
            }
            self.apply(command).await;
        }
        lock_unpoisoned(&self.runtime).consuming = false;
    }

    async fn apply(&self, command: ScoutCommand) {
        match command {
            ScoutCommand::Stop => self.stop().await,
            ScoutCommand::Drain => {
                {
                    let mut runtime = lock_unpoisoned(&self.runtime);
                    if runtime.draining {
                        return;
                    }
                    runtime.draining = true;
                    runtime.state.enabled = false;
                    runtime.state.next_attempt_at = None;
                    runtime.state.notice = Some(
                        "Draining: the in-flight scan finishes on this harness, then the worker \
                         exits."
                            .to_string(),
                    );
                    if runtime.active.is_some() {
                        self.publish_locked(&mut runtime);
                        return;
                    }
                }
                self.stop().await;
            }
            ScoutCommand::Refresh => self.refresh().await,
            ScoutCommand::Settings {
                interval_minutes,
                max_per_hour,
                max_pending,
            } => {
                if !is_valid_cadence(interval_minutes)
                    || !is_valid_limit(max_per_hour)
                    || !is_valid_limit(max_pending)
                {
                    let mut runtime = lock_unpoisoned(&self.runtime);
                    runtime.state.last_error = Some(
                        "Auto Scout settings must use a 1 through 1440 minute cadence and empty or \
                         1 through 100 limits."
                            .to_string(),
                    );
                    self.publish_locked(&mut runtime);
                    return;
                }
                {
                    let mut runtime = lock_unpoisoned(&self.runtime);
                    runtime.state.limits = ScoutLimits {
                        max_per_hour,
                        max_pending,
                    };
                    runtime.state.interval_minutes = interval_minutes;
                    runtime.state.last_error = None;
                    runtime.state.notice = Some(format!(
                        "Settings saved: every {interval_minutes} minute(s), {} per hour, {} open.",
                        limit_label(runtime.state.limits.max_per_hour),
                        limit_label(runtime.state.limits.max_pending)
                    ));
                    runtime.state.next_attempt_at = None;
                    self.publish_locked(&mut runtime);
                }
                let settings = ScoutSettings {
                    max_per_hour,
                    max_pending,
                    interval_minutes,
                };
                if let Err(error) =
                    write_settings(&settings_path(&self.state_dir, &self.repo_dir), &settings)
                {
                    (self.log)(&format!("could not persist settings: {error}"));
                }
            }
        }
    }

    /* -------------------------------------------------------------------- */
    /* Reads                                                                 */
    /* -------------------------------------------------------------------- */

    async fn read_github(&self, github: &Arc<dyn ScoutForge>) -> Result<GitHubRead, String> {
        let (issues, releases, open_titles) = tokio::join!(
            github.list_issues(),
            github.list_releases(),
            github.list_open_issue_titles()
        );
        Ok(GitHubRead {
            issues: issues?,
            releases: releases?,
            open_titles: open_titles?,
        })
    }

    async fn read_within_deadline(&self, deadline_ms: i64) -> Result<GitHubRead, String> {
        let remaining = deadline_ms - now_millis();
        if remaining <= 0 {
            return Err(format!(
                "the forge read did not finish within {} ms",
                self.read_timeout_ms
            ));
        }
        let github = Arc::clone(&lock_unpoisoned(&self.runtime).github);
        match tokio::time::timeout(
            Duration::from_millis(remaining as u64),
            self.read_github(&github),
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

    fn record_sync_failure(&self, detail: &str) {
        let now = (self.clock)();
        let kind = classify_forge_read_failure(detail);
        let mut runtime = lock_unpoisoned(&self.runtime);
        // A read that ran out of time is a slow forge, not a broken one. The
        // last read's rows still describe the repository, the four short retries
        // only add pages to the walk that stalled, and the fifth attempt would
        // raise an error notification that files a board issue and returns as
        // more work for the same forge. Keep the card stale with no reason and
        // read again on the normal cadence; a read that actually failed still
        // spends the failure schedule.
        if kind == ForgeReadFailureKind::Transient && is_forge_read_latency(detail) {
            runtime.state.sync = ScoutSync {
                state: "stale".to_string(),
                at: runtime.state.sync.at.clone(),
                error: None,
            };
            runtime.state.next_attempt_at = None;
            runtime.next_sync_at = now + self.sync_ms as i64;
            self.publish_locked(&mut runtime);
            drop(runtime);
            (self.log)(&format!("the forge read is slow: {detail}"));
            return;
        }
        let delay = if kind == ForgeReadFailureKind::Transient {
            runtime.retry.record(kind)
        } else {
            let _ = runtime.retry.record(kind);
            None
        };
        if let Some(delay) = delay {
            runtime.state.sync = ScoutSync {
                state: "stale".to_string(),
                at: runtime.state.sync.at.clone(),
                error: None,
            };
            let next_sync_at = now + delay as i64;
            runtime.next_sync_at = next_sync_at;
            self.publish_locked(&mut runtime);
            return;
        }
        runtime.state.sync = ScoutSync {
            state: "error".to_string(),
            at: runtime.state.sync.at.clone(),
            error: Some(detail.to_string()),
        };
        // A forge that could not answer is not the agent's own error. The spent
        // schedule already wrote the request and its cause to `agent-sync-error`,
        // where the page renders it with the last-read clock; raising it as
        // `agent-error` would open a dashboard error notification and file a
        // board issue back into the forge that is down. A refusal the forge
        // actually answered — an unusable credential, a missing repository — is
        // the operator's to fix and still takes the agent's error.
        runtime.state.last_error = (kind != ForgeReadFailureKind::RateLimit
            && !is_forge_read_outage(detail))
        .then(|| detail.to_string());
        runtime.state.notice = Some(format!("Could not read the forge: {detail}"));
        runtime.state.next_attempt_at = None;
        runtime.next_sync_at = now + self.sync_ms as i64;
        self.publish_locked(&mut runtime);
    }

    async fn apply_read(
        &self,
        read: &GitHubRead,
        deadline_ms: i64,
        github: &Arc<dyn ScoutForge>,
        log: &LogFn,
    ) -> ReadPatch {
        let (issues_before, signature_before) = {
            let runtime = lock_unpoisoned(&self.runtime);
            (
                runtime.state.issues.clone(),
                runtime.state.release_signature.clone(),
            )
        };
        apply_read_rows(
            &issues_before,
            signature_before.as_deref(),
            github,
            read,
            deadline_ms,
            (self.clock)(),
            log,
        )
        .await
    }

    /// The periodic check: every scout issue, every published release, and the
    /// open titles the next scan must not restate.
    pub async fn refresh(&self) {
        {
            let runtime = lock_unpoisoned(&self.runtime);
            if runtime.stopping
                || !runtime.state.enabled
                || runtime.syncing
                || runtime.active.as_ref().is_some_and(ActiveScan::is_filing)
            {
                return;
            }
        }
        lock_unpoisoned(&self.runtime).syncing = true;
        self.syncing_flag.store(true, Ordering::SeqCst);
        let deadline = now_millis() + self.read_timeout_ms as i64;
        let github = Arc::clone(&lock_unpoisoned(&self.runtime).github);
        let read = match self.read_within_deadline(deadline).await {
            Ok(read) => read,
            Err(detail) => {
                self.record_sync_failure(&detail);
                lock_unpoisoned(&self.runtime).syncing = false;
                self.syncing_flag.store(false, Ordering::SeqCst);
                return;
            }
        };
        let patch = self.apply_read(&read, deadline, &github, &self.log).await;
        let now = (self.clock)();
        {
            let mut runtime = lock_unpoisoned(&self.runtime);
            runtime.state.release_signature = Some(patch.release_signature);
            runtime.state.issues = patch.issues;
            runtime.open_titles = patch.open_titles.clone();
            runtime.state.open_titles = patch.open_titles;
            runtime.state.sync = ScoutSync {
                state: "ok".to_string(),
                at: Some(iso_from_millis(now)),
                error: None,
            };
            runtime.state.last_error = None;
            runtime.retry.succeed();
            runtime.next_sync_at = now + self.sync_ms as i64;
            self.publish_locked(&mut runtime);
            let capacity = scan_capacity(
                &runtime.state.issues,
                &runtime.state.limits,
                now,
                self.sync_ms,
            );
            if runtime.state.sync.state == "ok" && capacity.batch > 0 {
                runtime.state.next_attempt_at = None;
            }
            self.publish_locked(&mut runtime);
            runtime.syncing = false;
        }
        self.syncing_flag.store(false, Ordering::SeqCst);
    }

    /* -------------------------------------------------------------------- */
    /* Ticks and scans                                                       */
    /* -------------------------------------------------------------------- */

    pub async fn tick(&self) {
        if lock_unpoisoned(&self.runtime).stopping {
            return;
        }
        self.consume_commands().await;
        if lock_unpoisoned(&self.runtime).stopping {
            return;
        }
        {
            let draining = lock_unpoisoned(&self.runtime).draining;
            if draining {
                let no_active = lock_unpoisoned(&self.runtime).active.is_none();
                if no_active {
                    self.stop().await;
                }
                return;
            }
        }
        {
            let enabled = lock_unpoisoned(&self.runtime).state.enabled;
            if !enabled {
                return;
            }
        }
        self.mark_stale();
        {
            let runtime = lock_unpoisoned(&self.runtime);
            if runtime.syncing || runtime.active.as_ref().is_some_and(ActiveScan::is_filing) {
                return;
            }
        }
        let now = (self.clock)();
        let next_sync_at = lock_unpoisoned(&self.runtime).next_sync_at;
        if now >= next_sync_at {
            self.refresh().await;
            let runtime = lock_unpoisoned(&self.runtime);
            if runtime.stopping || !runtime.state.enabled {
                return;
            }
        }
        {
            let (active, sync_ok) = {
                let runtime = lock_unpoisoned(&self.runtime);
                (runtime.active.is_some(), runtime.state.sync.state == "ok")
            };
            if active {
                return;
            }
            if !sync_ok {
                return;
            }
        }
        if self.cooldown_remaining(now) || self.cadence_remaining(now) {
            return;
        }
        let capacity = {
            let runtime = lock_unpoisoned(&self.runtime);
            scan_capacity(
                &runtime.state.issues,
                &runtime.state.limits,
                now,
                self.sync_ms,
            )
        };
        if capacity.batch == 0 {
            self.block(capacity.blocked_until.map(iso_from_millis));
            return;
        }
        self.begin_scan().await;
    }

    /// Test seam: one tick against the injected clock, without the ticker.
    pub async fn tick_now(&self) {
        self.tick().await;
        self.settle().await;
    }

    /// Takes the in-flight scan's join handle once the task has finished.
    fn take_finished_join(&self) -> Option<tokio::task::JoinHandle<ScanCompletion>> {
        let mut runtime = lock_unpoisoned(&self.runtime);
        match runtime.active.as_mut() {
            None => None,
            Some(active) => match active.join.take() {
                Some(join) if join.is_finished() => Some(join),
                other => {
                    active.join = other;
                    None
                }
            },
        }
    }

    /// Waits until the in-flight scan (if any) has been recorded.
    pub async fn settle(&self) {
        loop {
            let finished = {
                let mut runtime = lock_unpoisoned(&self.runtime);
                match runtime
                    .active
                    .as_mut()
                    .and_then(|active| active.join.take())
                {
                    Some(join) if join.is_finished() => Some(join),
                    Some(join) => {
                        if let Some(active) = runtime.active.as_mut() {
                            active.join = Some(join);
                        }
                        None
                    }
                    None => {
                        return;
                    }
                }
            };
            if let Some(join) = finished {
                if let Ok(completion) = join.await {
                    self.finish_scan(completion).await;
                }
                continue;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    /// One scan: one request file, one prompt, one validated filing record.
    pub async fn begin_scan(&self) {
        {
            let runtime = lock_unpoisoned(&self.runtime);
            if runtime.stopping
                || runtime.draining
                || runtime.active.is_some()
                || runtime.starting
                || !runtime.state.enabled
                || runtime.state.sync.state != "ok"
            {
                return;
            }
        }
        let now = (self.clock)();
        if self.cooldown_remaining(now) || self.cadence_remaining(now) {
            return;
        }
        let capacity = {
            let runtime = lock_unpoisoned(&self.runtime);
            scan_capacity(
                &runtime.state.issues,
                &runtime.state.limits,
                now,
                self.sync_ms,
            )
        };
        if capacity.batch == 0 {
            self.block(capacity.blocked_until.map(iso_from_millis));
            return;
        }
        if !self.claim_scan_slot() {
            return;
        }
        lock_unpoisoned(&self.runtime).starting = true;
        let result = self.begin_scan_inner(now, capacity.batch).await;
        {
            let mut runtime = lock_unpoisoned(&self.runtime);
            runtime.starting = false;
            if runtime.active.is_none() {
                self.release_scan_slot_locked(&mut runtime);
            }
        }
        if let Err(error) = result {
            (self.log)(&error);
        }
    }

    async fn begin_scan_inner(&self, now: i64, batch: i64) -> Result<(), String> {
        let draft_goal_headings = read_draft_goal_headings(&self.repo_dir);
        let scan = create_scan_directory(&self.repo_dir, now)?;
        update_scan_claim(&self.repo_dir, &scan.scan_id);
        let requested = batch.min(UNLIMITED_SCAN_BATCH);
        let (repository, limits, provider_environment, github, issues_before, release_signature) = {
            let runtime = lock_unpoisoned(&self.runtime);
            (
                runtime.state.repo.clone(),
                runtime.state.limits.clone(),
                Arc::clone(&self.provider_environment),
                Arc::clone(&runtime.github),
                runtime.state.issues.clone(),
                runtime.state.release_signature.clone(),
            )
        };
        let request = build_request(
            &scan,
            &repository,
            &self.repo_dir,
            requested,
            &draft_goal_headings,
            &limits,
            None,
        )?;
        write_request(&scan.directory, &request).map_err(|error| error.to_string())?;
        let prompt = prompt_for(&scan.directory);
        let mut activity: Vec<String> = vec![format!(
            "entry point {}:{} (seed {})",
            request.entry_point.path, request.entry_point.line, request.seed
        )];
        let _ = write_activity(&scan.directory, &activity);

        let environment = match provider_environment.resolve().await {
            Ok(environment) => environment,
            Err(error) => {
                self.write_scan_start_failure(&scan, &prompt, requested, &error.to_string(), now);
                return Err(error.to_string());
            }
        };
        let mut env: HashMap<String, String> = environment
            .into_iter()
            .filter_map(|(key, value)| value.map(|value| (key, value)))
            .collect();
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
            scan.directory
                .join("tool-log.jsonl")
                .to_string_lossy()
                .into_owned(),
        );

        let shared = Arc::new(Mutex::new(ActiveShared {
            activity: std::mem::take(&mut activity),
            first_line: None,
            finished: false,
            last_activity_ms: now_millis(),
            filed: 0,
            filed_numbers: Vec::new(),
            settle: None,
            child: Arc::new(Mutex::new(None)),
            started: false,
        }));
        let notify = Arc::new(tokio::sync::Notify::new());
        let task = ScanTaskOptions {
            scan_id: scan.scan_id.clone(),
            directory: scan.directory.clone(),
            prompt: prompt.clone(),
            started_at: scan.started_at.clone(),
            requested,
            repo: repository.clone(),
            repo_dir: self.repo_dir.clone(),
            command: self.agent_command.clone(),
            environment: env,
            agent: Arc::clone(&self.agent),
            github,
            timeout_ms: self.timeout_ms,
            clock: Arc::clone(&self.clock),
            log: Arc::clone(&self.log),
            shared: Arc::clone(&shared),
            notify: Arc::clone(&notify),
            harness_version: self.harness_version.clone(),
            issues_before,
            release_signature_before: release_signature,
            syncing: Arc::clone(&self.syncing_flag),
        };
        write_scan_record(
            &scan.directory,
            &scan.scan_id,
            &repository,
            &self.repo_dir,
            "running",
            &scan.started_at,
            None,
            requested,
            0,
            &prompt,
            None,
            None,
            None,
            self.harness_version.as_deref(),
        );
        let join = tokio::spawn(run_scan_task(task));
        let abort = join.abort_handle();
        {
            let mut runtime = lock_unpoisoned(&self.runtime);
            runtime.state.scan = Some(ScoutScanRecord {
                scan_id: scan.scan_id.clone(),
                started_at: scan.started_at.clone(),
                requested,
            });
            runtime.state.last_scan_started_at = Some(scan.started_at.clone());
            runtime.state.newest_scan_id = Some(scan.scan_id.clone());
            runtime.state.lifecycle = ScoutLifecycle::Scanning.as_str().to_string();
            runtime.state.next_attempt_at = None;
            runtime.state.last_error = None;
            runtime.open_titles = runtime.state.open_titles.clone();
            runtime.active = Some(ActiveScan {
                scan_id: scan.scan_id.clone(),
                directory: scan.directory.clone(),
                requested,
                prompt: prompt.clone(),
                started_at: scan.started_at.clone(),
                shared,
                join: Some(join),
                abort,
            });
            self.publish_locked(&mut runtime);
        }
        Ok(())
    }

    fn write_scan_start_failure(
        &self,
        scan: &CreatedScan,
        prompt: &str,
        requested: i64,
        detail: &str,
        now: i64,
    ) {
        let repo = lock_unpoisoned(&self.runtime).state.repo.clone();
        write_scan_record(
            &scan.directory,
            &scan.scan_id,
            &repo,
            &self.repo_dir,
            "failed",
            &scan.started_at,
            Some(iso_from_millis((self.clock)())),
            requested,
            0,
            prompt,
            None,
            Some(detail),
            None,
            self.harness_version.as_deref(),
        );
        let mut runtime = lock_unpoisoned(&self.runtime);
        runtime.state.newest_scan_id = Some(scan.scan_id.clone());
        runtime.state.last_error = Some(detail.to_string());
        runtime.state.notice = Some(format!("Scan failed: {detail}"));
        runtime.state.lifecycle = ScoutLifecycle::Failed.as_str().to_string();
        runtime.state.next_attempt_at = Some(iso_from_millis(now + self.sync_ms as i64));
        self.publish_locked(&mut runtime);
    }

    fn claim_scan_slot(&self) -> bool {
        {
            let runtime = lock_unpoisoned(&self.runtime);
            if runtime.lease_held {
                return true;
            }
        }
        if !claim_scan(&self.repo_dir, self.harness_version.as_deref(), None) {
            return false;
        }
        lock_unpoisoned(&self.runtime).lease_held = true;
        true
    }

    fn release_scan_slot_locked(&self, runtime: &mut Runtime) {
        if !runtime.lease_held {
            return;
        }
        runtime.lease_held = false;
        release_scan_claim(&self.repo_dir);
    }

    fn release_scan_slot(&self) {
        let mut runtime = lock_unpoisoned(&self.runtime);
        self.release_scan_slot_locked(&mut runtime);
    }

    async fn finish_scan(&self, completion: ScanCompletion) {
        if let Some(detail) = &completion.sync_failure {
            self.record_sync_failure(detail);
        }
        if completion.start_failure {
            let draining = {
                let mut runtime = lock_unpoisoned(&self.runtime);
                runtime.state.scan = None;
                runtime.state.newest_scan_id = Some(completion.scan_id);
                runtime.state.lifecycle = ScoutLifecycle::Failed.as_str().to_string();
                runtime.state.last_error = completion.error.clone();
                runtime.state.notice = completion
                    .error
                    .as_ref()
                    .map(|error| format!("Scan failed: {error}"));
                runtime.state.next_attempt_at =
                    Some(iso_from_millis((self.clock)() + self.sync_ms as i64));
                self.publish_locked(&mut runtime);
                self.release_scan_slot_locked(&mut runtime);
                runtime.draining
            };
            if draining {
                self.stop().await;
            }
            return;
        }
        let now = (self.clock)();
        let cadence_ms = self.cadence_ms();
        {
            let mut runtime = lock_unpoisoned(&self.runtime);
            if let Some(patch) = &completion.read {
                runtime.state.issues = patch.issues.clone();
                runtime.state.release_signature = Some(patch.release_signature.clone());
                runtime.open_titles = patch.open_titles.clone();
                runtime.state.open_titles = patch.open_titles.clone();
                runtime.state.sync = ScoutSync {
                    state: "ok".to_string(),
                    at: Some(iso_from_millis(now)),
                    error: None,
                };
            }
            runtime.state.scan = None;
            runtime.state.newest_scan_id = Some(completion.scan_id.clone());
            // A refused create stays the last error whether or not it reduced
            // the batch; only a failed scan drives the notice and lifecycle.
            let failure = completion
                .error
                .clone()
                .or_else(|| completion.filing_error.clone());
            let rate_limited = failure.as_deref().is_some_and(is_github_rate_limited);
            runtime.state.last_error = if rate_limited { None } else { failure };
            if let Some(notice) = &completion.notice {
                runtime.state.notice = Some(notice.clone());
            }
            if let Some(error) = &completion.error {
                runtime.state.notice = Some(format!("Scan failed: {error}"));
            }
            runtime.state.lifecycle = if completion.error.is_none() {
                ScoutLifecycle::Idle.as_str().to_string()
            } else {
                ScoutLifecycle::Failed.as_str().to_string()
            };
            let capacity = scan_capacity(
                &runtime.state.issues,
                &runtime.state.limits,
                now,
                self.sync_ms,
            );
            let cadence_at = runtime
                .state
                .last_scan_started_at
                .as_deref()
                .and_then(parse_iso_millis)
                .map(|started| started + cadence_ms)
                .filter(|ready| *ready > now)
                .map(iso_from_millis);
            let cooldown_at = iso_from_millis(now + self.sync_ms as i64);
            let next = if capacity.batch > 0 {
                latest(cadence_at, Some(cooldown_at))
            } else {
                latest(
                    cadence_at,
                    Some(
                        capacity
                            .blocked_until
                            .map(iso_from_millis)
                            .unwrap_or(cooldown_at),
                    ),
                )
            };
            runtime.state.next_attempt_at = next;
            runtime.active = None;
            self.publish_locked(&mut runtime);
        }
        self.release_scan_slot();
        let draining = lock_unpoisoned(&self.runtime).draining;
        if draining {
            self.stop().await;
        }
    }

    /* -------------------------------------------------------------------- */
    /* Stop                                                                  */
    /* -------------------------------------------------------------------- */

    pub async fn stop(&self) {
        {
            let mut runtime = lock_unpoisoned(&self.runtime);
            if runtime.stopping {
                return;
            }
            runtime.stopping = true;
        }
        let active = {
            let mut runtime = lock_unpoisoned(&self.runtime);
            runtime.active.take()
        };
        if let Some(mut active) = active {
            let (settle, filed, finished) = {
                let shared = lock_unpoisoned(&active.shared);
                (
                    shared.settle.as_ref().map(|settle| settle.finished),
                    shared.filed,
                    shared.finished,
                )
            };
            let child = shared_child(&active.shared);
            let join = active.join.take();
            active.abort.abort();
            if let Some(join) = join {
                let _ = tokio::time::timeout(Duration::from_secs(2), join).await;
            }
            if settle == Some(false) {
                {
                    let mut shared = lock_unpoisoned(&active.shared);
                    if let Some(settle) = shared.settle.as_mut() {
                        settle.finished = true;
                    }
                    shared.finished = true;
                }
                write_scan_record(
                    &active.directory,
                    &active.scan_id,
                    &lock_unpoisoned(&self.runtime).state.repo,
                    &self.repo_dir,
                    "stopped",
                    &active.started_at,
                    Some(iso_from_millis((self.clock)())),
                    active.requested,
                    filed,
                    &active.prompt,
                    child.clone(),
                    None,
                    None,
                    self.harness_version.as_deref(),
                );
            } else if !finished {
                {
                    let mut shared = lock_unpoisoned(&active.shared);
                    shared.finished = true;
                }
                write_scan_record(
                    &active.directory,
                    &active.scan_id,
                    &lock_unpoisoned(&self.runtime).state.repo,
                    &self.repo_dir,
                    "stopped",
                    &active.started_at,
                    Some(iso_from_millis((self.clock)())),
                    active.requested,
                    0,
                    &active.prompt,
                    child,
                    None,
                    None,
                    self.harness_version.as_deref(),
                );
            }
        }
        let draining = lock_unpoisoned(&self.runtime).draining;
        {
            let mut runtime = lock_unpoisoned(&self.runtime);
            runtime.state.enabled = false;
            runtime.state.scan = None;
            runtime.state.next_attempt_at = None;
            runtime.state.notice = draining.then(|| {
                "Drained: the worker finished its work and exited; its records stay readable."
                    .to_string()
            });
            runtime.state.lifecycle = ScoutLifecycle::Stopped.as_str().to_string();
            self.publish_locked(&mut runtime);
        }
        self.release_scan_slot();
        let lock = lock_unpoisoned(&self.runtime).lock.take();
        if let Some(lock) = lock {
            lock.release();
        }
    }

    pub async fn shutdown(&self) {
        self.stop().await;
    }
}

fn limit_label(value: Option<i64>) -> String {
    value
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unlimited".to_string())
}

fn latest(left: Option<String>, right: Option<String>) -> Option<String> {
    match (left, right) {
        (None, right) => right,
        (left, None) => left,
        (Some(left), Some(right)) => {
            let left_at = parse_iso_millis(&left);
            let right_at = parse_iso_millis(&right);
            match (left_at, right_at) {
                (Some(left_at), Some(right_at)) if left_at >= right_at => Some(left),
                (Some(_), Some(_)) => Some(right),
                _ => Some(left),
            }
        }
    }
}

struct NullForge;

impl ScoutForge for NullForge {
    fn list_issues(&self) -> ForgeFuture<Vec<ScoutForgeIssue>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    fn list_open_issue_titles(&self) -> ForgeFuture<Vec<String>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    fn list_releases(&self) -> ForgeFuture<Vec<GitHubRelease>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    fn closing_client(&self) -> &dyn ClosingCommitClient {
        &NullClosingClient
    }
}

struct NullClosingClient;

impl ClosingCommitClient for NullClosingClient {
    fn closing_commit(&self, _issue_number: i64) -> crate::forge::ClientFuture<'_, Option<String>> {
        Box::pin(async { Ok(None) })
    }
    fn resolve_commit(&self, _short: String) -> crate::forge::ClientFuture<'_, Option<String>> {
        Box::pin(async { Ok(None) })
    }
    fn containing_release_tags(
        &self,
        _commit: String,
        _releases: Vec<GitHubRelease>,
    ) -> crate::forge::ClientFuture<'_, Vec<String>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

/* ------------------------------------------------------------------------ */
/* One scan task                                                             */
/* ------------------------------------------------------------------------ */

struct ScanTaskOptions {
    scan_id: String,
    directory: PathBuf,
    prompt: String,
    started_at: String,
    requested: i64,
    repo: String,
    repo_dir: PathBuf,
    command: String,
    environment: HashMap<String, String>,
    agent: ScanAgent,
    github: Arc<dyn ScoutForge>,
    timeout_ms: i64,
    clock: Clock,
    log: LogFn,
    shared: Arc<Mutex<ActiveShared>>,
    notify: Arc<tokio::sync::Notify>,
    harness_version: Option<String>,
    issues_before: Vec<ScoutIssueRow>,
    release_signature_before: Option<String>,
    syncing: Arc<AtomicBool>,
}

fn shared_child(shared: &Arc<Mutex<ActiveShared>>) -> Option<ScoutAcpChild> {
    let shared = lock_unpoisoned(shared);
    let child = lock_unpoisoned(&shared.child);
    child.clone()
}

fn scan_child(task: &ScanTaskOptions) -> Option<ScoutAcpChild> {
    shared_child(&task.shared)
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

fn record_scan_line(task: &ScanTaskOptions, text: &str) {
    let bounded: String = text.chars().take(MAX_ACTIVITY_LINE).collect();
    let mut shared = lock_unpoisoned(&task.shared);
    append_activity_line(&mut shared.activity, &bounded, false);
    let activity = shared.activity.clone();
    drop(shared);
    let _ = write_activity(&task.directory, &activity);
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
            let parsed: Value = serde_json::from_str(trimmed).ok()?;
            if parsed.is_object() {
                Some(parsed)
            } else {
                None
            }
        })
        .collect()
}

fn tool_value_number(value: Option<&Value>, field: &str) -> Option<i64> {
    let number = value?.get(field)?.as_i64()?;
    (number > 0).then_some(number)
}

fn tool_value_string(value: Option<&Value>, field: &str) -> Option<String> {
    value?
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn write_scan_record(
    directory: &Path,
    scan_id: &str,
    repo: &str,
    root: &Path,
    status: &str,
    started_at: &str,
    finished_at: Option<String>,
    requested: i64,
    filed: i64,
    prompt: &str,
    acp: Option<ScoutAcpChild>,
    error: Option<&str>,
    shortfall: Option<&str>,
    harness_version: Option<&str>,
) {
    let scan = ScoutScanFile {
        version: SCAN_VERSION,
        scan_id: scan_id.to_string(),
        repo: repo.to_string(),
        root: root.to_string_lossy().into_owned(),
        status: status.to_string(),
        started_at: started_at.to_string(),
        finished_at,
        requested,
        filed,
        prompt: prompt.to_string(),
        acp,
        error: error.map(str::to_string),
        shortfall: shortfall.map(str::to_string),
        worker_pid: std::process::id(),
        harness_version: harness_version.map(str::to_string),
    };
    let _ = write_scan_file(directory, &scan);
}

async fn run_scan_task(task: ScanTaskOptions) -> ScanCompletion {
    let now = (task.clock)();
    let activity_hook = {
        let shared = Arc::clone(&task.shared);
        let notify = Arc::clone(&task.notify);
        let directory = task.directory.clone();
        let clock = Arc::clone(&task.clock);
        Arc::new(move |entry: AcpActivity| {
            let mut shared = lock_unpoisoned(&shared);
            if shared.finished {
                return;
            }
            append_activity_line(&mut shared.activity, &entry.text, entry.append);
            shared.last_activity_ms = (clock)();
            let activity = shared.activity.clone();
            drop(shared);
            let _ = write_activity(&directory, &activity);
            notify.notify_one();
        })
    };
    let update_hook = {
        let shared = Arc::clone(&task.shared);
        let notify = Arc::clone(&task.notify);
        let clock = Arc::clone(&task.clock);
        Arc::new(move || {
            let mut shared = lock_unpoisoned(&shared);
            if shared.finished {
                return;
            }
            shared.last_activity_ms = (clock)();
            drop(shared);
            notify.notify_one();
        })
    };
    let stderr_hook = {
        let shared = Arc::clone(&task.shared);
        Arc::new(move |text: &str| {
            let mut shared = lock_unpoisoned(&shared);
            if shared.finished || shared.first_line.is_some() {
                return;
            }
            let line = bounded_line(text);
            if !line.is_empty() {
                shared.first_line = Some(line);
            }
        })
    };
    let child = Arc::clone(&lock_unpoisoned(&task.shared).child);
    let started = {
        let shared = Arc::clone(&task.shared);
        Arc::new(move || {
            lock_unpoisoned(&shared).started = true;
        })
    };
    let child_recorded = {
        let scan_id = task.scan_id.clone();
        let directory = task.directory.clone();
        let repo = task.repo.clone();
        let repo_dir = task.repo_dir.clone();
        let started_at = task.started_at.clone();
        let prompt = task.prompt.clone();
        let requested = task.requested;
        let harness_version = task.harness_version.clone();
        Arc::new(move |child: ScoutAcpChild| {
            write_scan_record(
                &directory,
                &scan_id,
                &repo,
                &repo_dir,
                "running",
                &started_at,
                None,
                requested,
                0,
                &prompt,
                Some(child),
                None,
                None,
                harness_version.as_deref(),
            );
        })
    };
    let context = ScanAgentContext {
        command: task.command.clone(),
        cwd: task.repo_dir.clone(),
        env: task.environment.clone(),
        prompt: task.prompt.clone(),
        directory: task.directory.clone(),
        activity: activity_hook,
        update: update_hook,
        stderr: stderr_hook,
        child: Arc::clone(&child),
        child_recorded,
        started,
    };
    let mut agent = (task.agent)(context);
    let result = loop {
        let deadline = {
            let shared = lock_unpoisoned(&task.shared);
            shared.last_activity_ms + task.timeout_ms
        };
        let remaining = (deadline - now_millis()).max(1) as u64;
        tokio::select! {
            result = &mut agent => break Some(result),
            _ = task.notify.notified() => continue,
            _ = tokio::time::sleep(Duration::from_millis(remaining)) => break None,
        }
    };
    let started = lock_unpoisoned(&task.shared).started;
    match result {
        None => {
            record_scan_line(&task, "failed: the scan timed out");
            let first_line = {
                let mut shared = lock_unpoisoned(&task.shared);
                shared.finished = true;
                shared.first_line.clone()
            };
            let child = scan_child(&task);
            let error = first_line.unwrap_or_else(|| "the scan timed out".to_string());
            write_scan_record(
                &task.directory,
                &task.scan_id,
                &task.repo,
                &task.repo_dir,
                "failed",
                &task.started_at,
                Some(iso_from_millis((task.clock)())),
                task.requested,
                0,
                &task.prompt,
                child,
                Some(&error),
                None,
                task.harness_version.as_deref(),
            );
            ScanCompletion {
                scan_id: task.scan_id.clone(),
                read: None,
                sync_failure: None,
                notice: None,
                error: Some(error),
                filing_error: None,
                start_failure: !started,
            }
        }
        Some(Err(detail)) => {
            let detail = if detail.is_empty() {
                "the agent ended its turn with an error".to_string()
            } else {
                detail
            };
            record_scan_line(&task, &format!("failed: {detail}"));
            let first_line = {
                let mut shared = lock_unpoisoned(&task.shared);
                shared.finished = true;
                shared.first_line.clone()
            };
            let child = scan_child(&task);
            let error = first_line.unwrap_or(detail);
            write_scan_record(
                &task.directory,
                &task.scan_id,
                &task.repo,
                &task.repo_dir,
                "failed",
                &task.started_at,
                Some(iso_from_millis((task.clock)())),
                task.requested,
                0,
                &task.prompt,
                child,
                Some(&error),
                None,
                task.harness_version.as_deref(),
            );
            ScanCompletion {
                scan_id: task.scan_id.clone(),
                read: None,
                sync_failure: None,
                notice: None,
                error: Some(error),
                filing_error: None,
                start_failure: !started,
            }
        }
        Some(Ok(())) => {
            let settle_deadline = now_millis() + task.timeout_ms;
            {
                let mut shared = lock_unpoisoned(&task.shared);
                shared.finished = true;
                shared.settle = Some(SettleShared { finished: false });
            }
            complete_scan(task, settle_deadline, now).await
        }
    }
}

async fn complete_scan(
    task: ScanTaskOptions,
    settle_deadline: i64,
    _started: i64,
) -> ScanCompletion {
    // The whole settle-and-file phase shares one deadline.
    let settled = tokio::time::timeout(
        Duration::from_millis((settle_deadline - now_millis()).max(1) as u64),
        complete_scan_inner(&task, settle_deadline),
    )
    .await;
    match settled {
        Ok(completion) => completion,
        Err(_) => {
            let detail = "the scan timed out while reading and filing";
            record_scan_line(&task, &format!("failed: {detail}"));
            let filed = {
                let mut shared = lock_unpoisoned(&task.shared);
                if let Some(settle) = shared.settle.as_mut() {
                    settle.finished = true;
                }
                shared.filed
            };
            let child = scan_child(&task);
            write_scan_record(
                &task.directory,
                &task.scan_id,
                &task.repo,
                &task.repo_dir,
                "failed",
                &task.started_at,
                Some(iso_from_millis((task.clock)())),
                task.requested,
                filed,
                &task.prompt,
                child,
                Some(detail),
                None,
                task.harness_version.as_deref(),
            );
            ScanCompletion {
                scan_id: task.scan_id.clone(),
                read: None,
                sync_failure: None,
                notice: None,
                error: Some(detail.to_string()),
                filing_error: None,
                start_failure: false,
            }
        }
    }
}

async fn complete_scan_inner(task: &ScanTaskOptions, settle_deadline: i64) -> ScanCompletion {
    let finish = |read: Option<ReadPatch>, sync_failure: Option<String>, error: Option<String>| {
        ScanCompletion {
            scan_id: task.scan_id.clone(),
            read,
            sync_failure,
            notice: None,
            error,
            filing_error: None,
            start_failure: false,
        }
    };
    let child = || scan_child(task);

    // A periodic read already in flight owns the forge client; let it finish
    // so the settle read and its resolution never interleave with it.
    while task.syncing.load(Ordering::SeqCst) {
        if now_millis() >= settle_deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    // Read the forge again, so a periodic read cannot overwrite a just-created
    // row and the reconcile sees the filings the agent made.
    let remaining = settle_deadline - now_millis();
    if remaining <= 0 {
        return finish(
            None,
            None,
            Some("the scan timed out while reading and filing".to_string()),
        );
    }
    let read = match tokio::time::timeout(Duration::from_millis(remaining as u64), async {
        let (issues, releases, open_titles) = tokio::join!(
            task.github.list_issues(),
            task.github.list_releases(),
            task.github.list_open_issue_titles()
        );
        Ok::<GitHubRead, String>(GitHubRead {
            issues: issues?,
            releases: releases?,
            open_titles: open_titles?,
        })
    })
    .await
    {
        Ok(Ok(read)) => read,
        Ok(Err(detail)) => {
            record_scan_line(task, &format!("failed: {detail}"));
            write_scan_record(
                &task.directory,
                &task.scan_id,
                &task.repo,
                &task.repo_dir,
                "failed",
                &task.started_at,
                Some(iso_from_millis((task.clock)())),
                task.requested,
                lock_unpoisoned(&task.shared).filed,
                &task.prompt,
                child(),
                Some(&detail),
                None,
                task.harness_version.as_deref(),
            );
            return finish(None, Some(detail.clone()), Some(detail));
        }
        Err(_) => {
            let detail = "the scan timed out while reading and filing".to_string();
            record_scan_line(task, &format!("failed: {detail}"));
            write_scan_record(
                &task.directory,
                &task.scan_id,
                &task.repo,
                &task.repo_dir,
                "failed",
                &task.started_at,
                Some(iso_from_millis((task.clock)())),
                task.requested,
                lock_unpoisoned(&task.shared).filed,
                &task.prompt,
                child(),
                Some(&detail),
                None,
                task.harness_version.as_deref(),
            );
            return finish(None, None, Some(detail));
        }
    };

    let patch = apply_read_rows(
        &task.issues_before,
        task.release_signature_before.as_deref(),
        &task.github,
        &read,
        settle_deadline,
        (task.clock)(),
        &task.log,
    )
    .await;

    // The filing evidence is the issue tool's own log, never an answer file.
    let mut filed = 0i64;
    let mut filed_numbers: Vec<i64> = Vec::new();
    let mut last_filed: Option<(i64, String)> = None;
    let mut filing_error: Option<String> = None;
    for record in read_tool_log(&task.directory.join("tool-log.jsonl")) {
        if record.get("tool").and_then(Value::as_str) != Some("issue_create") {
            continue;
        }
        let value = record.get("value");
        let number = tool_value_number(value, "number");
        let title = tool_value_string(value, "title");
        if record.get("ok").and_then(Value::as_bool) == Some(true) {
            if let (Some(number), Some(title)) = (number, title) {
                if filed >= task.requested {
                    record_scan_line(
                        task,
                        &format!("filed beyond the requested count: #{number}"),
                    );
                    continue;
                }
                filed += 1;
                filed_numbers.push(number);
                last_filed = Some((number, title.clone()));
                record_scan_line(task, &format!("filed #{number} \u{201c}{title}\u{201d}"));
                continue;
            }
        }
        let detail = record
            .get("error")
            .and_then(Value::as_str)
            .filter(|detail| !detail.is_empty())
            .unwrap_or("the issue-creation tool failed")
            .to_string();
        if filing_error.is_none() {
            filing_error = Some(detail.clone());
        }
        record_scan_line(task, &format!("failed: {detail}"));
    }
    {
        let mut shared = lock_unpoisoned(&task.shared);
        shared.filed = filed;
        shared.filed_numbers = filed_numbers.clone();
        if let Some(settle) = shared.settle.as_mut() {
            settle.finished = true;
        }
    }

    let shortfall = (filed < task.requested).then(|| {
        filing_error
            .clone()
            .unwrap_or_else(|| format!("filed {filed} of the {} requested", task.requested))
    });
    if let Some(shortfall) = &shortfall {
        record_scan_line(task, &format!("shortfall: {shortfall}"));
    }
    // The status follows the count the scan reached, never the presence of a
    // refused `issue_create`: a complete batch stays succeeded even with an
    // extra refusal after it, and a short batch is its own incomplete state.
    let status = if filed >= task.requested {
        "succeeded"
    } else {
        SCAN_STATUS_INCOMPLETE
    };
    write_scan_record(
        &task.directory,
        &task.scan_id,
        &task.repo,
        &task.repo_dir,
        status,
        &task.started_at,
        Some(iso_from_millis((task.clock)())),
        task.requested,
        filed,
        &task.prompt,
        child(),
        filing_error.as_deref(),
        shortfall.as_deref(),
        task.harness_version.as_deref(),
    );
    let notice = match &last_filed {
        Some((number, title)) if filed == 1 => {
            Some(format!("Filed #{number} \u{201c}{title}\u{201d}"))
        }
        Some(_) => Some(format!(
            "Filed {filed} issues in {}: {}",
            task.repo,
            filed_numbers
                .iter()
                .map(|number| format!("#{number}"))
                .collect::<Vec<_>>()
                .join(", ")
        )),
        None => None,
    };
    let mut completion = finish(Some(patch), None, None);
    completion.filing_error = filing_error;
    completion.notice = notice;
    completion
}

/// Applies one read: every row, and the release resolution for closed rows
/// without a version. A closed issue with no shipped version costs forge
/// requests, so each attempt is recorded on its row.
#[allow(clippy::too_many_arguments)]
async fn apply_read_rows(
    issues_before: &[ScoutIssueRow],
    signature_before: Option<&str>,
    github: &Arc<dyn ScoutForge>,
    read: &GitHubRead,
    deadline_ms: i64,
    now: i64,
    log: &LogFn,
) -> ReadPatch {
    let previous: HashMap<i64, &ScoutIssueRow> =
        issues_before.iter().map(|row| (row.number, row)).collect();
    let signature = read
        .releases
        .iter()
        .map(|release| format!("{}@{}", release.tag, release.published_at))
        .collect::<Vec<String>>();
    let mut sorted = signature.clone();
    sorted.sort();
    let signature = sorted.join("\n");
    let releases_changed = Some(signature.as_str()) != signature_before;
    let mut rows: Vec<ScoutIssueRow> = Vec::new();
    let mut withheld: Vec<(&ScoutForgeIssue, usize)> = Vec::new();
    for issue in &read.issues {
        let before = previous.get(&issue.number).copied();
        let implemented = issue.state == "closed";
        let category = before
            .and_then(|row| row.category.clone())
            .or_else(|| category_from_body(&issue.body));
        let row = ScoutIssueRow {
            number: issue.number,
            title: issue.title.clone(),
            url: issue.url.clone(),
            created_at: issue.created_at.clone(),
            state: if implemented {
                ScoutIssueState::Implemented
            } else {
                ScoutIssueState::Pending
            },
            category,
            version: if implemented {
                before.and_then(|row| row.version.clone())
            } else {
                None
            },
            version_attempt_at: if implemented {
                before.and_then(|row| row.version_attempt_at.clone())
            } else {
                None
            },
            version_error: if implemented {
                before.and_then(|row| row.version_error.clone())
            } else {
                None
            },
        };
        let index = rows.len();
        rows.push(row);
        let row = &rows[index];
        if row.state != ScoutIssueState::Implemented || row.version.is_some() {
            continue;
        }
        let client = github.closing_client();
        let landed = client.landed_commits(issue.number);
        if landed.is_empty() && !releases_changed && now - attempt_time(row) < RESOLUTION_RETRY_MS {
            continue;
        }
        withheld.push((issue, index));
    }
    withheld.sort_by(|left, right| {
        let left_row = &rows[left.1];
        let right_row = &rows[right.1];
        attempt_time(left_row)
            .cmp(&attempt_time(right_row))
            .then(left_row.number.cmp(&right_row.number))
    });
    for (issue, index) in withheld {
        let remaining = deadline_ms - now_millis();
        if remaining <= 0 {
            break;
        }
        let resolution = resolve_within(
            &rows[index],
            issue.closed_at.as_deref(),
            github,
            &read.releases,
            remaining,
        )
        .await;
        let row = &mut rows[index];
        row.version_attempt_at = Some(iso_from_millis(now));
        row.version_error = resolution.error.clone();
        if let Some(version) = resolution.version {
            row.version = Some(version);
            row.version_error = None;
            if resolution.inferred {
                (log)(&format!(
                    "#{}: no closing commit; read {} from the release published closest to the close",
                    row.number,
                    row.version.clone().unwrap_or_default()
                ));
            }
        } else {
            (log)(&format!(
                "#{}: no shipped version: {}",
                row.number,
                resolution.error.as_deref().unwrap_or("no reason")
            ));
        }
        let _ = issue;
    }
    ReadPatch {
        issues: newest_first(rows),
        release_signature: signature,
        open_titles: read.open_titles.clone(),
    }
}

fn attempt_time(row: &ScoutIssueRow) -> i64 {
    row.version_attempt_at
        .as_deref()
        .and_then(parse_iso_millis)
        .unwrap_or(0)
}

/// Newest creation first; the number breaks a same-instant tie.
fn newest_first(rows: Vec<ScoutIssueRow>) -> Vec<ScoutIssueRow> {
    let mut rows = rows;
    rows.sort_by(|left, right| {
        let left_at = parse_iso_millis(&left.created_at);
        let right_at = parse_iso_millis(&right.created_at);
        match (left_at, right_at) {
            (Some(left_at), Some(right_at)) if left_at != right_at => right_at.cmp(&left_at),
            _ => right.number.cmp(&left.number),
        }
    });
    rows
}

async fn resolve_within(
    row: &ScoutIssueRow,
    closed_at: Option<&str>,
    github: &Arc<dyn ScoutForge>,
    releases: &[GitHubRelease],
    remaining_ms: i64,
) -> VersionResolution {
    let issue = ClosingCommitIssue {
        number: row.number,
        state: IssueState::Closed,
        created_at: Some(row.created_at.clone()),
        closed_at: closed_at.map(str::to_string),
    };
    let client = github.closing_client();
    match tokio::time::timeout(
        Duration::from_millis(remaining_ms.max(1) as u64),
        resolve_shipped_version(&issue, client, releases),
    )
    .await
    {
        Ok(resolution) => resolution,
        Err(_) => VersionResolution {
            version: None,
            error: Some(format!(
                "release resolution did not finish within {remaining_ms} ms"
            )),
            inferred: false,
        },
    }
}

/* ------------------------------------------------------------------------ */
/* The production loop and CLI                                               */
/* ------------------------------------------------------------------------ */

/// Runs the detached worker until a Stop, a completed drain, or a signal.
pub async fn run_worker(worker: &ScoutWorker) -> bool {
    let mut signal = SignalListener::new();
    loop {
        {
            let stopping = lock_unpoisoned(&worker.runtime).stopping;
            if stopping {
                break;
            }
        }
        if let Some(join) = worker.take_finished_join() {
            if let Ok(completion) = join.await {
                worker.finish_scan(completion).await;
            }
            continue;
        }
        worker.tick().await;
        {
            let stopping = lock_unpoisoned(&worker.runtime).stopping;
            if stopping {
                break;
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(worker.tick_ms)) => {}
            _ = signal.recv() => {
                (worker.log)("received a signal");
                worker.shutdown().await;
                break;
            }
        }
    }
    worker.stop().await;
    true
}

struct SignalListener {
    #[cfg(unix)]
    terminate: Option<tokio::signal::unix::Signal>,
    #[cfg(unix)]
    interrupt: Option<tokio::signal::unix::Signal>,
}

impl SignalListener {
    fn new() -> Self {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};
            Self {
                terminate: signal(SignalKind::terminate()).ok(),
                interrupt: signal(SignalKind::interrupt()).ok(),
            }
        }
        #[cfg(not(unix))]
        {
            Self {}
        }
    }

    async fn recv(&mut self) {
        #[cfg(unix)]
        {
            tokio::select! {
                _ = async {
                    match self.terminate.as_mut() {
                        Some(signal) => { signal.recv().await; }
                        None => std::future::pending::<()>().await,
                    }
                } => {}
                _ = async {
                    match self.interrupt.as_mut() {
                        Some(signal) => { signal.recv().await; }
                        None => std::future::pending::<()>().await,
                    }
                } => {}
            }
        }
        #[cfg(not(unix))]
        {
            std::future::pending::<()>().await;
        }
    }
}

/// Runs one cycle of this family's engine from the worker CLI.
pub async fn run(invocation: &WorkerInvocation) -> anyhow::Result<()> {
    let repo_dir = if invocation.repo_dir.as_os_str().is_empty() {
        eprintln!("usage: devboard worker scout --repo <checkout> --state-dir <dir> [--sync <ms>]");
        std::process::exit(2);
    } else {
        absolute(&invocation.repo_dir)
    };
    if invocation.state_dir.as_os_str().is_empty() {
        eprintln!("usage: devboard worker scout --repo <checkout> --state-dir <dir> [--sync <ms>]");
        std::process::exit(2);
    }
    let state_dir = absolute(&invocation.state_dir);
    let repository = crate::forge::origin_repository(&repo_dir).unwrap_or_default();
    if repository.is_empty() {
        eprintln!("scout worker: the checkout's origin does not name a repository");
        std::process::exit(2);
    }
    let harness_version = std::env::var("DEVBOARD_HARNESS_VERSION")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| read_harness_version(&repo_dir.join(".devboard")));
    if live_lock_owner(&version_lock_path(
        &lock_path(&repo_dir),
        harness_version.as_deref(),
    ))
    .is_some()
    {
        eprintln!("scout worker: this checkout already has a live scout for this version");
        std::process::exit(0);
    }
    let sync_ms = invocation
        .option("sync")
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value >= MIN_SYNC_MS)
        .or_else(|| {
            std::env::var("SCOUT_SYNC_MS")
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .filter(|value| *value >= MIN_SYNC_MS)
        });
    let mut options = ScoutWorkerOptions::new(&repo_dir, &state_dir);
    options.harness_version = harness_version;
    options.sync_ms = sync_ms;
    options.log = Some(Arc::new(|line: &str| {
        eprintln!("scout: {line}");
    }));
    let worker = ScoutWorker::new(options);
    if !worker.start(&repository) {
        std::process::exit(0);
    }
    run_worker(&worker).await;
    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capacity_counts_the_rolling_hour_and_open_rows() {
        let now = parse_iso_millis("2026-11-03T12:00:00.000Z").expect("an instant");
        let issues = vec![ScoutIssueRow {
            number: 1,
            title: "one".to_string(),
            url: "https://example.test/1".to_string(),
            created_at: "2026-11-03T11:30:00.000Z".to_string(),
            state: ScoutIssueState::Pending,
            category: None,
            version: None,
            version_attempt_at: None,
            version_error: None,
        }];
        let limits = ScoutLimits {
            max_per_hour: Some(10),
            max_pending: Some(5),
        };
        let capacity = scan_capacity(&issues, &limits, now, 60_000);
        assert_eq!(capacity.window_count, 1);
        assert_eq!(capacity.open_count, 1);
        assert_eq!(capacity.batch, 4);
        assert_eq!(capacity.blocked_until, None);
    }

    #[test]
    fn an_invalid_limit_refuses_settings() {
        assert!(is_valid_limit(None));
        assert!(is_valid_limit(Some(1)));
        assert!(is_valid_limit(Some(100)));
        assert!(!is_valid_limit(Some(0)));
        assert!(!is_valid_limit(Some(101)));
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
        let tick = super::TICK_MS;
        assert!(tick >= 250, "the control tick is {tick} ms");
    }
}
