//! Issues mode: the dashboard half and the detached worker.
//!
//! The dashboard never owns a poll loop, an agent, or the worker's lock: it
//! reads the worker's repo-scoped state, replays its activity, and writes
//! commands to it. A worker started here is detached in its own session, so
//! killing the server leaves it running and a replacement reattaches.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};
use time::macros::format_description;
use time::OffsetDateTime;

use crate::app::{App, Conn};
use crate::command::Command;

/// The directory every repository's issues records sit below.
const ISSUES_DIRECTORY: &str = "issues";
const STATE_VERSION: u64 = 2;
const LEDGER_VERSION: u64 = 1;
const RUN_HISTORY_LIMIT: usize = 50;
const ACTIVITY_MAX_ENTRIES: usize = 1000;
const ACTIVITY_MAX_BYTES: usize = 1024 * 1024;
const ACTIVITY_TRIMMED_MARKER: &str = "Earlier activity was trimmed.";

/// A goal issue carries the one label the goal lifecycle claims.
fn is_goal_issue(issue: &Issue) -> bool {
    issue.labels.iter().any(|label| label == GOAL_LABEL)
}

/// The command's grace, after which a worker the table proves is signalled.
const STOP_PROOF_MS: u64 = 3_000;
/// How long a proven worker gets to exit after SIGTERM before SIGKILL.
const STOP_KILL_GRACE_MS: u64 = 2_000;
/// Start waits no longer than the whole stop proof window for the peer to exit.
const STOP_DEADLINE_MS: u64 = STOP_PROOF_MS + STOP_KILL_GRACE_MS;
const STOP_POLL_MS: u64 = 50;

/// How often a connected dashboard re-reads the origin's open issues.
const TRACKER_SYNC_INTERVAL_MS: u64 = 30_000;
/// Whole-read deadline for one tracker read.
const TRACKER_TIMEOUT_MS: u64 = 20_000;
/// The dashboard's own snapshot cadence.
const DASHBOARD_POLL_MS: u64 = 250;
/// A page polls one resource every 1000 ms while the document is visible, so
/// one sync interval plus this window still names a page that is reading.
const CLIENT_POLL_MS: i64 = 1_000;
/// Default wall-clock bound for the whole start preflight.
const ISSUES_PREFLIGHT_TIMEOUT_MS: u64 = 20_000;

const MAX_CONCURRENT_PEERS: usize = 30;
const MAX_FOLLOW_UP_TURNS: u32 = 4;
const TURN_SILENCE_MS: u64 = 30 * 60_000;
const DEFAULT_INTERVAL_MS: u64 = 10_000;
/// How often the dashboard checks whether an enabled worker disappeared.
const AUTO_RESUME_INTERVAL_MS: u64 = 2_000;
/// The quiet period after one restart attempt, so a worker that exits at once
/// is not spawned in a tight loop.
const AUTO_RESUME_BACKOFF_MS: u64 = 15_000;
const COOLDOWN_MS: u64 = 5 * 60_000;
const DISMISS_MS: u64 = 2 * 60_000;
const WORKER_TICK_MS: u64 = 100;
const IMPLEMENT_ISSUE_COMMAND: &str = "/implement-issue";
const IMPLEMENT_GOAL_COMMAND: &str = "/implement-goal-issue";
const GOAL_LABEL: &str = "goal";
const DEFAULT_AGENT_COMMAND: &str = "omp acp";
const FIRST_LINE_MAX: usize = 400;

/* ------------------------------------------------------------------------ */
/* Time                                                                      */
/* ------------------------------------------------------------------------ */

/// The ISO 8601 text `Date.prototype.toISOString` writes.
fn iso(dt: OffsetDateTime) -> String {
    let format =
        format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z");
    dt.format(&format)
        .unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".to_string())
}

static MONOTONIC_START: LazyLock<std::time::Instant> = LazyLock::new(std::time::Instant::now);

/// Milliseconds since this process started.
///
/// The demand and throttle clocks must not move backwards: a wall-clock step
/// would otherwise leave the tracker unread until the clock caught up.
fn monotonic_millis() -> i64 {
    MONOTONIC_START.elapsed().as_millis() as i64
}

fn iso_now() -> String {
    iso(OffsetDateTime::now_utc())
}

fn parse_iso(text: &str) -> Option<OffsetDateTime> {
    let bytes = text.as_bytes();
    if bytes.len() < 20
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let number = |range: std::ops::Range<usize>| -> Option<i64> {
        std::str::from_utf8(&bytes[range]).ok()?.parse().ok()
    };
    let year = number(0..4)? as i32;
    let month = number(5..7)?;
    let day = number(8..10)?;
    let hour = number(11..13)?;
    let minute = number(14..16)?;
    let second = number(17..19)?;
    let (millis, rest) = if bytes.get(19) == Some(&b'.') {
        let mut digits = String::new();
        let mut index = 20;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            digits.push(bytes[index] as char);
            index += 1;
        }
        if digits.is_empty() {
            return None;
        }
        while digits.len() < 3 {
            digits.push('0');
        }
        (digits[..3].parse::<i64>().ok()?, index)
    } else {
        (0, 19)
    };
    if rest + 1 != bytes.len() || bytes.get(rest) != Some(&b'Z') {
        return None;
    }
    let days = days_from_civil(year, month, day);
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second;
    OffsetDateTime::from_unix_timestamp(seconds)
        .ok()
        .map(|dt| dt + time::Duration::milliseconds(millis))
}

/// Days since 1970-01-01 for a proleptic Gregorian date.
fn days_from_civil(year: i32, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year } as i64;
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn epoch_millis(dt: OffsetDateTime) -> i64 {
    (dt.unix_timestamp_nanos() / 1_000_000) as i64
}

fn iso_from_millis(ms: i64) -> String {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .map(iso)
        .unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".to_string())
}

/* ------------------------------------------------------------------------ */
/* Issues paths                                                              */
/* ------------------------------------------------------------------------ */

fn issues_root(state_dir: &Path) -> PathBuf {
    state_dir.join(ISSUES_DIRECTORY)
}

fn repo_state_directory(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    issues_root(state_dir).join(crate::journal::journal_key(repo_dir))
}

fn state_path(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    repo_state_directory(state_dir, repo_dir).join("state.json")
}

fn worker_version_key(version: Option<&str>) -> String {
    let text = match version {
        Some(value) if !value.is_empty() => value,
        _ => "unknown",
    };
    text.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn versioned_state_path(state_dir: &Path, repo_dir: &Path, version: Option<&str>) -> PathBuf {
    repo_state_directory(state_dir, repo_dir)
        .join("workers")
        .join(worker_version_key(version))
        .join("state.json")
}

fn versioned_control_directory(
    state_dir: &Path,
    repo_dir: &Path,
    version: Option<&str>,
) -> PathBuf {
    repo_state_directory(state_dir, repo_dir)
        .join("workers")
        .join(worker_version_key(version))
        .join("control")
}

fn drain_marker_path(state_dir: &Path, repo_dir: &Path, version: Option<&str>) -> PathBuf {
    repo_state_directory(state_dir, repo_dir)
        .join("workers")
        .join(worker_version_key(version))
        .join("drain.json")
}

fn worker_state_directories(state_dir: &Path, repo_dir: &Path) -> Vec<PathBuf> {
    let workers = repo_state_directory(state_dir, repo_dir).join("workers");
    let mut directories = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&workers) {
        for entry in entries.flatten() {
            if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                directories.push(entry.path());
            }
        }
    }
    directories.sort();
    directories
}

fn ledger_path(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    repo_state_directory(state_dir, repo_dir).join("ledger.json")
}

fn runs_directory(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    repo_state_directory(state_dir, repo_dir).join("runs")
}

fn run_directory(state_dir: &Path, repo_dir: &Path, run_id: &str) -> PathBuf {
    runs_directory(state_dir, repo_dir).join(run_id)
}

fn control_directory(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    repo_state_directory(state_dir, repo_dir).join("control")
}

fn claims_directory(repo_dir: &Path) -> PathBuf {
    repo_dir
        .join(".devboard")
        .join(".tmp")
        .join(ISSUES_DIRECTORY)
        .join("claims")
}

fn closed_by_run_directory(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    repo_state_directory(state_dir, repo_dir).join("closed-by-run")
}

/// The repository-anchored lock a checkout cannot duplicate.
fn lock_path(repo_dir: &Path) -> PathBuf {
    repo_dir
        .join(".devboard")
        .join(".tmp")
        .join(ISSUES_DIRECTORY)
        .join("lock")
}

fn versioned_lock_path(repo_dir: &Path, version: Option<&str>) -> PathBuf {
    PathBuf::from(format!(
        "{}.{}",
        lock_path(repo_dir).display(),
        worker_version_key(version)
    ))
}

/* ------------------------------------------------------------------------ */
/* Lock owners                                                               */
/* ------------------------------------------------------------------------ */

/// One live worker's lock record.
#[derive(Debug, Clone, PartialEq, Eq)]
struct LockOwner {
    pid: u32,
    started_at: String,
    repo: String,
    state_dir: String,
    harness_version: Option<String>,
    argv: Vec<String>,
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

/// The platform facts a lock owner's liveness depends on.
///
/// A lock records the owner's pid and start instant. A pid alone cannot prove
/// identity: the OS recycles pids. `/proc` supplies the start instant, and a
/// platform without it can only prove the pid is alive. Keeping the two probes
/// behind one trait makes that rule explicit and lets a test run it where
/// `/proc` is unavailable.
trait LockProbe: Send + Sync {
    fn pid_alive(&self, pid: u32) -> bool;
    /// The instant `pid` started, in epoch milliseconds, when the platform
    /// reports it.
    fn process_started_at(&self, pid: u32) -> Option<i64>;
    /// Whether this platform has a process table that reports start instants.
    fn reports_process_start(&self) -> bool;
}

struct SystemLockProbe;

impl LockProbe for SystemLockProbe {
    fn pid_alive(&self, pid: u32) -> bool {
        pid_alive(pid)
    }

    fn process_started_at(&self, pid: u32) -> Option<i64> {
        process_started_at(pid)
    }

    fn reports_process_start(&self) -> bool {
        cfg!(target_os = "linux")
    }
}

/// The instant a live process started, from `/proc/<pid>/stat` and uptime.
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
    let now = (SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis()) as f64;
    Some((now - uptime * 1000.0 + start_ticks * 10.0) as i64)
}

fn own_started_at() -> String {
    let started = process_started_at(std::process::id()).unwrap_or_else(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or(0)
    });
    iso_from_millis(started)
}

/// True when the live pid belongs to the lock's owner and not to a recycled
/// pid. A start instant the platform reports must match the recorded one; a
/// platform that reports none treats a live pid as the owner, which is the only
/// proof available there.
fn owner_alive_with(owner: &LockOwner, probe: &dyn LockProbe) -> bool {
    if !probe.pid_alive(owner.pid) {
        return false;
    }
    let Some(recorded) = parse_iso(&owner.started_at) else {
        return false;
    };
    let recorded = epoch_millis(recorded);
    match probe.process_started_at(owner.pid) {
        Some(actual) => (actual - recorded).abs() <= 2_000,
        None => !probe.reports_process_start(),
    }
}

fn owner_alive(owner: &LockOwner) -> bool {
    owner_alive_with(owner, &SystemLockProbe)
}

fn parse_lock(text: &str) -> Option<LockOwner> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    let object = parsed.as_object()?;
    let pid = object.get("pid").and_then(Value::as_u64)?;
    if pid == 0 || pid > u32::MAX as u64 {
        return None;
    }
    let started_at = object.get("startedAt").and_then(Value::as_str)?;
    Some(LockOwner {
        pid: pid as u32,
        started_at: started_at.to_string(),
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

fn live_lock_owner(path: &Path) -> Option<LockOwner> {
    let owner = read_lock(path)?;
    owner_alive(&owner).then_some(owner)
}

/// Every live owner beside one lock path: the legacy lock and each version.
fn live_lock_owners(path: &Path) -> Vec<LockOwner> {
    let mut owners = Vec::new();
    if let Some(legacy) = live_lock_owner(path) {
        owners.push(legacy);
    }
    let Some(parent) = path.parent() else {
        return owners;
    };
    let Some(base) = path.file_name().and_then(|name| name.to_str()) else {
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

/// Takes a version's lock, treating a same-version legacy lock as the same
/// worker. Returns the owner that already holds it on refusal.
// The refusal carries the live owner record itself; boxing it would allocate on
// a path that exists to report an already-running worker, not to be cheap.
#[allow(clippy::result_large_err)]
fn acquire_worker_lock(
    repo_dir: &Path,
    version: Option<&str>,
    details: (&Path, &Path, Option<String>, Vec<String>),
) -> Result<LockOwner, Option<LockOwner>> {
    let base = lock_path(repo_dir);
    if let Some(legacy) = live_lock_owner(&base) {
        if legacy.harness_version.is_none() || legacy.harness_version.as_deref() == version {
            return Err(Some(legacy));
        }
    }
    acquire_lock(&versioned_lock_path(repo_dir, version), details)
}

/// Takes one lock file, or reports the live owner.
#[allow(clippy::result_large_err)]
fn acquire_lock(
    path: &Path,
    details: (&Path, &Path, Option<String>, Vec<String>),
) -> Result<LockOwner, Option<LockOwner>> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let owner = LockOwner {
        pid: std::process::id(),
        started_at: own_started_at(),
        repo: details.0.to_string_lossy().into_owned(),
        state_dir: details.1.to_string_lossy().into_owned(),
        harness_version: details.2.clone(),
        argv: details.3.clone(),
    };
    let token = uuid::Uuid::new_v4().to_string();
    for _attempt in 0..2 {
        let staged = PathBuf::from(format!(
            "{}.new-{}-{}",
            path.display(),
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
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
            Ok(()) => return Ok(owner),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let Some(existing) = read_lock(path) else {
                    continue;
                };
                if owner_alive(&existing) {
                    return Err(Some(existing));
                }
                reclaim_stale_lock(path);
            }
            Err(error) => {
                eprintln!("issues: could not take {}: {error}", path.display());
                return Err(None);
            }
        }
    }
    Err(None)
}

/// Moves an inspected stale lock aside, restoring a newer lock that arrived.
fn reclaim_stale_lock(path: &Path) {
    let aside = PathBuf::from(format!(
        "{}.reclaim-{}-{}",
        path.display(),
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    if std::fs::rename(path, &aside).is_err() {
        return;
    }
    if let Some(moved) = read_lock(&aside) {
        if owner_alive(&moved) {
            let _ = std::fs::hard_link(&aside, path);
            let _ = std::fs::remove_file(&aside);
            return;
        }
    }
    let _ = std::fs::remove_file(&aside);
}

fn release_lock(path: &Path, token: &str) {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(_) => return,
    };
    let parsed: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(_) => return,
    };
    if parsed.get("token").and_then(Value::as_str) != Some(token) {
        return;
    }
    let _ = std::fs::remove_file(path);
}

/* ------------------------------------------------------------------------ */
/* Issue claims                                                              */
/* ------------------------------------------------------------------------ */

#[derive(Debug, Clone)]
struct IssueClaim {
    number: u64,
    pid: u32,
    run_id: String,
}

fn claim_path(repo_dir: &Path, number: u64) -> PathBuf {
    claims_directory(repo_dir).join(format!("{number}.json"))
}

fn parse_claim(text: &str) -> Option<IssueClaim> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    let object = parsed.as_object()?;
    let number = object.get("number").and_then(Value::as_u64)?;
    let pid = object.get("pid").and_then(Value::as_u64)?;
    if pid == 0 || pid > u32::MAX as u64 {
        return None;
    }
    let run_id = object.get("runId").and_then(Value::as_str)?;
    Some(IssueClaim {
        number,
        pid: pid as u32,
        run_id: run_id.to_string(),
    })
}

fn read_issue_claim(repo_dir: &Path, number: u64) -> Option<IssueClaim> {
    std::fs::read_to_string(claim_path(repo_dir, number))
        .ok()
        .and_then(|text| parse_claim(&text))
}

fn live_issue_claims(repo_dir: &Path) -> Vec<IssueClaim> {
    let mut claims = Vec::new();
    let Ok(entries) = std::fs::read_dir(claims_directory(repo_dir)) else {
        return claims;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Some(claim) = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| parse_claim(&text))
        else {
            let _ = std::fs::remove_file(&path);
            continue;
        };
        if !pid_alive(claim.pid) {
            let _ = std::fs::remove_file(&path);
            continue;
        }
        claims.push(claim);
    }
    claims
}

fn claim_issue(repo_dir: &Path, number: u64, run_id: &str, version: Option<&str>) -> bool {
    if std::fs::create_dir_all(claims_directory(repo_dir)).is_err() {
        return false;
    }
    let path = claim_path(repo_dir, number);
    let claim = json!({
        "number": number,
        "pid": std::process::id(),
        "runId": run_id,
        "harnessVersion": version,
    });
    for _attempt in 0..2 {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                use std::io::Write as _;
                let _ =
                    file.write_all(format!("{}\n", crate::jsjson::stringify(&claim)).as_bytes());
                return true;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let Some(existing) = read_issue_claim(repo_dir, number) else {
                    continue;
                };
                if existing.pid == std::process::id() && existing.run_id == run_id {
                    return true;
                }
                if pid_alive(existing.pid) {
                    return false;
                }
                let _ = std::fs::remove_file(&path);
            }
            Err(_) => return false,
        }
    }
    false
}

fn release_issue_claim(repo_dir: &Path, number: u64) {
    let Some(existing) = read_issue_claim(repo_dir, number) else {
        return;
    };
    if existing.pid != std::process::id() {
        return;
    }
    let _ = std::fs::remove_file(claim_path(repo_dir, number));
}

/* ------------------------------------------------------------------------ */
/* Control channel                                                           */
/* ------------------------------------------------------------------------ */

static COMMAND_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq)]
pub enum IssuesCommand {
    Pause,
    Resume,
    Stop,
    Drain,
    Check,
    Answer {
        id: Value,
        value: String,
        run_id: Option<String>,
    },
    Abandon {
        number: u64,
    },
}

impl IssuesCommand {
    fn to_json(&self) -> Value {
        match self {
            Self::Pause => json!({"type": "pause"}),
            Self::Resume => json!({"type": "resume"}),
            Self::Stop => json!({"type": "stop"}),
            Self::Drain => json!({"type": "drain"}),
            Self::Check => json!({"type": "check"}),
            Self::Answer { id, value, run_id } => {
                let mut object = Map::new();
                object.insert("type".into(), Value::String("answer".into()));
                object.insert("id".into(), id.clone());
                object.insert("value".into(), Value::String(value.clone()));
                if let Some(run_id) = run_id {
                    object.insert("runId".into(), Value::String(run_id.clone()));
                }
                Value::Object(object)
            }
            Self::Abandon { number } => json!({"type": "abandon", "number": number}),
        }
    }

    fn parse(text: &str) -> Option<Self> {
        let parsed: Value = serde_json::from_str(text).ok()?;
        let object = parsed.as_object()?;
        match object.get("type").and_then(Value::as_str)? {
            "pause" => Some(Self::Pause),
            "resume" => Some(Self::Resume),
            "stop" => Some(Self::Stop),
            "drain" => Some(Self::Drain),
            "check" => Some(Self::Check),
            "answer" => {
                let id = object.get("id")?;
                let valid_id = id.is_number() || id.is_string();
                let value = object.get("value").and_then(Value::as_str)?;
                let run_id = object.get("runId").map(Value::as_str);
                if !valid_id {
                    return None;
                }
                let run_id = match run_id {
                    None => None,
                    Some(Some(text)) => Some(text.to_string()),
                    Some(None) => return None,
                };
                Some(Self::Answer {
                    id: id.clone(),
                    value: value.to_string(),
                    run_id,
                })
            }
            "abandon" => {
                let number = object.get("number").and_then(Value::as_u64)?;
                (number > 0).then_some(Self::Abandon { number })
            }
            _ => None,
        }
    }
}

fn write_command(directory: &Path, command: &IssuesCommand) -> std::io::Result<()> {
    std::fs::create_dir_all(directory)?;
    let sequence = COMMAND_SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let name = format!("{stamp:014}-{sequence:06}.json");
    let path = directory.join(name);
    let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    std::fs::write(
        &temporary,
        format!("{}\n", crate::jsjson::stringify(&command.to_json())),
    )?;
    std::fs::rename(&temporary, &path)
}

fn take_commands(directory: &Path) -> Vec<IssuesCommand> {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
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
        if let Some(command) = IssuesCommand::parse(&text) {
            commands.push(command);
        }
    }
    commands
}

#[derive(Debug, Clone)]
struct DrainMarker {
    version: Option<String>,
    pid: u32,
    by: Option<String>,
    at: String,
}

fn write_drain_marker(path: &Path, marker: &DrainMarker) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    let document = json!({
        "version": marker.version,
        "pid": marker.pid,
        "by": marker.by,
        "at": marker.at,
    });
    std::fs::write(&temporary, format!("{}\n", pretty_json(&document)))?;
    std::fs::rename(&temporary, path)
}

fn read_drain_marker(path: &Path) -> Option<DrainMarker> {
    let text = std::fs::read_to_string(path).ok()?;
    let parsed: Value = serde_json::from_str(&text).ok()?;
    let object = parsed.as_object()?;
    let pid = object.get("pid").and_then(Value::as_u64)?;
    if pid == 0 || pid > u32::MAX as u64 {
        return None;
    }
    let at = object.get("at").and_then(Value::as_str)?;
    Some(DrainMarker {
        version: object
            .get("version")
            .and_then(Value::as_str)
            .map(str::to_string),
        pid: pid as u32,
        by: object.get("by").and_then(Value::as_str).map(str::to_string),
        at: at.to_string(),
    })
}

/// `JSON.stringify(value, null, 2)`: two spaces per level, no trailing spaces.
fn pretty_json(value: &Value) -> String {
    fn write(value: &Value, depth: usize, out: &mut String) {
        match value {
            Value::Object(object) => {
                if object.is_empty() {
                    out.push_str("{}");
                    return;
                }
                out.push('{');
                for (index, (key, item)) in object.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    out.push('\n');
                    out.push_str(&"  ".repeat(depth + 1));
                    crate::jsjson::write_value(&Value::String(key.clone()), out);
                    out.push_str(": ");
                    write(item, depth + 1, out);
                }
                out.push('\n');
                out.push_str(&"  ".repeat(depth));
                out.push('}');
            }
            Value::Array(items) => {
                if items.is_empty() {
                    out.push_str("[]");
                    return;
                }
                out.push('[');
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    out.push('\n');
                    out.push_str(&"  ".repeat(depth + 1));
                    write(item, depth + 1, out);
                }
                out.push('\n');
                out.push_str(&"  ".repeat(depth));
                out.push(']');
            }
            other => crate::jsjson::write_value(other, out),
        }
    }
    let mut out = String::new();
    write(value, 0, &mut out);
    out
}

/* ------------------------------------------------------------------------ */
/* State document                                                            */
/* ------------------------------------------------------------------------ */

/// One forge issue as the worker and dashboard carry it.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub created_at: String,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

fn is_issue(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.get("number").and_then(Value::as_u64).is_some()
        && object.get("title").and_then(Value::as_str).is_some()
        && object.get("url").and_then(Value::as_str).is_some()
        && object.get("createdAt").and_then(Value::as_str).is_some()
        && object
            .get("labels")
            .map(|labels| {
                labels.is_null()
                    || labels
                        .as_array()
                        .map(|entries| entries.iter().all(Value::is_string))
                        .unwrap_or(false)
            })
            .unwrap_or(true)
        && object
            .get("body")
            .map(|body| body.is_null() || body.is_string())
            .unwrap_or(true)
}

fn issue_from_value(value: &Value) -> Option<Issue> {
    if !is_issue(value) {
        return None;
    }
    Some(Issue {
        number: value.get("number")?.as_u64()?,
        title: value.get("title")?.as_str()?.to_string(),
        url: value.get("url")?.as_str()?.to_string(),
        created_at: value.get("createdAt")?.as_str()?.to_string(),
        labels: value
            .get("labels")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        body: value
            .get("body")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueuedIssue {
    number: u64,
    title: String,
    url: String,
    created_at: String,
    #[serde(default)]
    labels: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    body: Option<String>,
    handled: bool,
    run_id: Option<String>,
    agent_run_id: Option<String>,
}

impl QueuedIssue {
    fn from_issue(
        issue: &Issue,
        handled: Option<&HandledIssue>,
        agent_run_id: Option<String>,
    ) -> Self {
        Self {
            number: issue.number,
            title: issue.title.clone(),
            url: issue.url.clone(),
            created_at: issue.created_at.clone(),
            labels: issue.labels.clone(),
            body: issue.body.clone(),
            handled: handled.is_some(),
            run_id: handled.map(|entry| entry.run_id.clone()),
            agent_run_id,
        }
    }
}

fn is_queued(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.get("handled").and_then(Value::as_bool).is_some()
        && nullable_string(object.get("runId"))
        && is_issue(value)
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunSummary {
    run_id: String,
    status: String,
    started_at: String,
    finished_at: Option<String>,
    exit_code: Option<i64>,
    issue_numbers: Vec<u64>,
    activity: usize,
    first_stderr_line: Option<String>,
    #[serde(default)]
    harness_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    worker_pid: Option<u32>,
}

fn is_run_summary(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    matches!(
        object.get("status").and_then(Value::as_str),
        Some("running") | Some("succeeded") | Some("failed") | Some("stopped")
    ) && object.get("runId").and_then(Value::as_str).is_some()
        && object.get("startedAt").and_then(Value::as_str).is_some()
        && nullable_string(object.get("finishedAt"))
        && object
            .get("exitCode")
            .map(|value| value.is_null() || value.as_i64().is_some())
            .unwrap_or(false)
        && object
            .get("issueNumbers")
            .and_then(Value::as_array)
            .map(|entries| entries.iter().all(|entry| entry.as_u64().is_some()))
            .unwrap_or(false)
        && object
            .get("activity")
            .map(|value| value.as_u64().is_some())
            .unwrap_or(false)
        && nullable_string(object.get("firstStderrLine"))
        && object
            .get("harnessVersion")
            .map(|value| value.is_null() || value.is_string())
            .unwrap_or(true)
        && object
            .get("workerPid")
            .map(|value| value.as_u64().is_some())
            .unwrap_or(true)
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuestionOption {
    label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    recommended: bool,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssuesQuestion {
    id: Value,
    message: String,
    options: Vec<QuestionOption>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
struct AcpChild {
    pid: u32,
    argv: Vec<String>,
    cwd: String,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Agent {
    run_id: String,
    issue_number: u64,
    started_at: String,
    question: Option<IssuesQuestion>,
    acp: Option<AcpChild>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerRecord {
    pid: u32,
    started_at: String,
    state_dir: String,
    harness_version: Option<String>,
    argv: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PollState {
    interval_ms: u64,
    last_poll_at: Option<String>,
    next_poll_at: Option<String>,
    etag: Option<String>,
    not_modified: bool,
    rate_limited_until: Option<String>,
    error: Option<String>,
}

impl PollState {
    fn empty(interval_ms: u64) -> Self {
        Self {
            interval_ms,
            last_poll_at: None,
            next_poll_at: None,
            etag: None,
            not_modified: false,
            rate_limited_until: None,
            error: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssuesState {
    version: u64,
    repo: String,
    root: String,
    lifecycle: String,
    enabled: bool,
    paused: bool,
    #[serde(default)]
    pause_source: Option<String>,
    worker: Option<WorkerRecord>,
    poll: PollState,
    queue: Vec<QueuedIssue>,
    runs: Vec<RunSummary>,
    agents: Vec<Agent>,
    #[serde(default)]
    cooldowns: BTreeMap<String, String>,
    last_error: Option<String>,
    last_exit_code: Option<i64>,
    finished_at: Option<String>,
    notice: Option<String>,
    /// The start this pass had to defer, or none. It is recomputed on every
    /// pass, so a resolved deferral never outlives the condition that caused
    /// it, and a reader never sees a claim about peers that no longer run.
    #[serde(default)]
    deferral: Option<String>,
    updated_at: String,
}

fn nullable_string(value: Option<&Value>) -> bool {
    match value {
        None => true,
        Some(value) => value.is_null() || value.is_string(),
    }
}

/// True for a deferral line written into `notice` by an older harness. It
/// describes a start that is not in force, so it is never shown as a notice.
fn is_deferral_shaped(text: &str) -> bool {
    let text = text.trim_end();
    text.contains("deferred:") && text.ends_with("the start is deferred")
}

fn empty_state(repo: &str, root: &str, interval_ms: u64, lifecycle: &str) -> IssuesState {
    IssuesState {
        version: STATE_VERSION,
        repo: repo.to_string(),
        root: root.to_string(),
        lifecycle: lifecycle.to_string(),
        enabled: false,
        paused: false,
        pause_source: None,
        worker: None,
        poll: PollState::empty(interval_ms),
        queue: Vec::new(),
        runs: Vec::new(),
        agents: Vec::new(),
        cooldowns: BTreeMap::new(),
        last_error: None,
        last_exit_code: None,
        finished_at: None,
        notice: None,
        deferral: None,
        updated_at: iso_now(),
    }
}

fn is_worker_record(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.get("pid").and_then(Value::as_u64).is_some()
        && object.get("startedAt").and_then(Value::as_str).is_some()
        && object.get("stateDir").and_then(Value::as_str).is_some()
        && nullable_string(object.get("harnessVersion"))
        && object
            .get("argv")
            .and_then(Value::as_array)
            .map(|entries| entries.iter().all(Value::is_string))
            .unwrap_or(false)
}

fn is_poll_state(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.get("intervalMs").and_then(Value::as_u64).is_some()
        && nullable_string(object.get("lastPollAt"))
        && nullable_string(object.get("nextPollAt"))
        && nullable_string(object.get("etag"))
        && object.get("notModified").and_then(Value::as_bool).is_some()
        && nullable_string(object.get("rateLimitedUntil"))
        && nullable_string(object.get("error"))
}

fn is_question(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let valid_id = object
        .get("id")
        .map(|id| id.is_number() || id.is_string())
        .unwrap_or(false);
    valid_id
        && object.get("message").and_then(Value::as_str).is_some()
        && object
            .get("options")
            .and_then(Value::as_array)
            .map(|options| {
                options.iter().all(|option| {
                    let Some(option) = option.as_object() else {
                        return false;
                    };
                    option.get("label").and_then(Value::as_str).is_some()
                        && option
                            .get("description")
                            .map(|value| value.is_null() || value.is_string())
                            .unwrap_or(true)
                        && option.get("recommended").and_then(Value::as_bool).is_some()
                })
            })
            .unwrap_or(false)
}

fn is_acp_child(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.get("pid").and_then(Value::as_u64).is_some()
        && object
            .get("argv")
            .and_then(Value::as_array)
            .map(|entries| entries.iter().all(Value::is_string))
            .unwrap_or(false)
        && object.get("cwd").and_then(Value::as_str).is_some()
}

fn is_agent(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.get("runId").and_then(Value::as_str).is_some()
        && object.get("issueNumber").and_then(Value::as_u64).is_some()
        && object.get("startedAt").and_then(Value::as_str).is_some()
        && object
            .get("question")
            .map(|question| question.is_null() || is_question(question))
            .unwrap_or(false)
        && object
            .get("acp")
            .map(|acp| acp.is_null() || is_acp_child(acp))
            .unwrap_or(false)
}

/// Parses one document; `None` means the bytes are not this version.
fn parse_state(text: &str) -> Option<IssuesState> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    let object = parsed.as_object()?;
    let version = object.get("version").and_then(Value::as_u64)?;
    if version != 1 && version != STATE_VERSION {
        return None;
    }
    let repo = object.get("repo").and_then(Value::as_str)?.to_string();
    let root = object.get("root").and_then(Value::as_str)?.to_string();
    let lifecycle = object.get("lifecycle").and_then(Value::as_str)?;
    if !matches!(
        lifecycle,
        "stopped" | "idle" | "running" | "pausing" | "paused" | "failed"
    ) {
        return None;
    }
    let enabled = object.get("enabled").and_then(Value::as_bool)?;
    let paused = object.get("paused").and_then(Value::as_bool)?;
    if let Some(source) = object.get("pauseSource") {
        if !source.is_null()
            && source.as_str() != Some("operator")
            && source.as_str() != Some("drain")
        {
            return None;
        }
    }
    if let Some(worker) = object.get("worker") {
        if !worker.is_null() && !is_worker_record(worker) {
            return None;
        }
    }
    let poll = object.get("poll")?;
    if !is_poll_state(poll) {
        return None;
    }
    let queue = object.get("queue")?.as_array()?;
    if !queue.iter().all(is_queued) {
        return None;
    }
    let runs = object.get("runs")?.as_array()?;
    if !runs.iter().all(is_run_summary) {
        return None;
    }
    let previous = version == 1;
    let agents: Vec<Agent> = if previous {
        Vec::new()
    } else {
        let agents = object.get("agents")?.as_array()?;
        if !agents.iter().all(is_agent) {
            return None;
        }
        agents
            .iter()
            .filter_map(|agent| serde_json::from_value(agent.clone()).ok())
            .collect()
    };
    let cooldowns_value = if previous {
        object.get("goalCooldowns")
    } else {
        object.get("cooldowns")
    };
    let cooldowns = match cooldowns_value {
        None => BTreeMap::new(),
        Some(value) if value.is_null() => BTreeMap::new(),
        Some(value) => {
            let map = value.as_object()?;
            let mut cooldowns = BTreeMap::new();
            for (key, entry) in map {
                cooldowns.insert(key.clone(), entry.as_str()?.to_string());
            }
            cooldowns
        }
    };
    if !nullable_string(object.get("lastError")) {
        return None;
    }
    if let Some(exit_code) = object.get("lastExitCode") {
        if !exit_code.is_null() && exit_code.as_i64().is_none() {
            return None;
        }
    }
    if !nullable_string(object.get("finishedAt"))
        || !nullable_string(object.get("notice"))
        || !nullable_string(object.get("deferral"))
    {
        return None;
    }
    let updated_at = object.get("updatedAt").and_then(Value::as_str)?;
    Some(IssuesState {
        version: STATE_VERSION,
        repo,
        root,
        lifecycle: lifecycle.to_string(),
        enabled,
        paused,
        pause_source: object
            .get("pauseSource")
            .and_then(Value::as_str)
            .map(str::to_string),
        worker: object
            .get("worker")
            .filter(|value| !value.is_null())
            .and_then(|value| serde_json::from_value(value.clone()).ok()),
        poll: serde_json::from_value(poll.clone()).ok()?,
        queue: queue
            .iter()
            .filter_map(|value| {
                let issue = issue_from_value(value)?;
                Some(QueuedIssue {
                    number: issue.number,
                    title: issue.title,
                    url: issue.url,
                    created_at: issue.created_at,
                    labels: issue.labels,
                    body: issue.body,
                    handled: value.get("handled")?.as_bool()?,
                    run_id: value
                        .get("runId")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    agent_run_id: value
                        .get("agentRunId")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                })
            })
            .collect(),
        runs: runs
            .iter()
            .filter_map(|value| serde_json::from_value(value.clone()).ok())
            .collect(),
        agents,
        cooldowns,
        last_error: object
            .get("lastError")
            .and_then(Value::as_str)
            .map(str::to_string),
        last_exit_code: object.get("lastExitCode").and_then(Value::as_i64),
        finished_at: object
            .get("finishedAt")
            .and_then(Value::as_str)
            .map(str::to_string),
        notice: object
            .get("notice")
            .and_then(Value::as_str)
            .map(str::to_string),
        deferral: object
            .get("deferral")
            .and_then(Value::as_str)
            .map(str::to_string),
        updated_at: updated_at.to_string(),
    })
}

fn read_state(path: &Path) -> Option<IssuesState> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| parse_state(&text))
}

fn write_state(path: &Path, state: &IssuesState) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    let value = serde_json::to_value(state).unwrap_or(Value::Null);
    std::fs::write(&temporary, format!("{}\n", pretty_json(&value)))?;
    std::fs::rename(&temporary, path)
}

fn load_state_with_text(path: &Path) -> (Option<IssuesState>, Option<String>) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return (None, None);
    };
    let state = parse_state(&text);
    if state.is_none() {
        quarantine(path);
    }
    (state, Some(text))
}

fn quarantine(path: &Path) -> Option<PathBuf> {
    let stamp = iso_now().replace([':', '.'], "-");
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

/* ------------------------------------------------------------------------ */
/* Run records                                                               */
/* ------------------------------------------------------------------------ */

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunFile {
    version: u64,
    run_id: String,
    repo: String,
    status: String,
    argv: Vec<String>,
    cwd: String,
    started_at: String,
    finished_at: Option<String>,
    exit_code: Option<i64>,
    issues: Vec<Issue>,
    first_stderr_line: Option<String>,
    worker_pid: u32,
    harness_version: Option<String>,
}

fn parse_run_file(text: &str) -> Option<RunFile> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    let object = parsed.as_object()?;
    if object.get("version").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    object.get("runId").and_then(Value::as_str)?;
    object.get("repo").and_then(Value::as_str)?;
    let status = object.get("status").and_then(Value::as_str)?;
    if !matches!(status, "running" | "succeeded" | "failed" | "stopped") {
        return None;
    }
    let argv = object.get("argv")?.as_array()?;
    if !argv.iter().all(Value::is_string) {
        return None;
    }
    object.get("cwd").and_then(Value::as_str)?;
    object.get("startedAt").and_then(Value::as_str)?;
    if !nullable_string(object.get("finishedAt")) {
        return None;
    }
    if let Some(exit_code) = object.get("exitCode") {
        if !exit_code.is_null() && exit_code.as_i64().is_none() {
            return None;
        }
    }
    let issues = object.get("issues")?.as_array()?;
    if !issues.iter().all(is_issue) {
        return None;
    }
    if !nullable_string(object.get("firstStderrLine")) {
        return None;
    }
    let worker_pid = object.get("workerPid")?.as_u64()?;
    if worker_pid == 0 || worker_pid > u32::MAX as u64 {
        return None;
    }
    if !nullable_string(object.get("harnessVersion")) {
        return None;
    }
    Some(RunFile {
        version: 1,
        run_id: object.get("runId")?.as_str()?.to_string(),
        repo: object.get("repo")?.as_str()?.to_string(),
        status: status.to_string(),
        argv: argv
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        cwd: object.get("cwd")?.as_str()?.to_string(),
        started_at: object.get("startedAt")?.as_str()?.to_string(),
        finished_at: object
            .get("finishedAt")
            .and_then(Value::as_str)
            .map(str::to_string),
        exit_code: object.get("exitCode").and_then(Value::as_i64),
        issues: issues.iter().filter_map(issue_from_value).collect(),
        first_stderr_line: object
            .get("firstStderrLine")
            .and_then(Value::as_str)
            .map(str::to_string),
        worker_pid: worker_pid as u32,
        harness_version: object
            .get("harnessVersion")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn run_file_path(directory: &Path) -> PathBuf {
    directory.join("run.json")
}

fn activity_path(directory: &Path) -> PathBuf {
    directory.join("activity.json")
}

fn write_run_file(directory: &Path, run: &RunFile) -> std::io::Result<()> {
    std::fs::create_dir_all(directory)?;
    let path = run_file_path(directory);
    let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    let value = serde_json::to_value(run).unwrap_or(Value::Null);
    std::fs::write(&temporary, format!("{}\n", pretty_json(&value)))?;
    std::fs::rename(&temporary, path)
}

fn parse_activity(text: &str) -> Option<Vec<String>> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    let entries = parsed.as_array()?;
    if !entries.iter().all(Value::is_string) {
        return None;
    }
    Some(
        entries
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
    )
}

fn read_activity(directory: &Path) -> Vec<String> {
    std::fs::read_to_string(activity_path(directory))
        .ok()
        .and_then(|text| parse_activity(&text))
        .unwrap_or_default()
}

fn write_activity(directory: &Path, lines: &[String]) -> std::io::Result<()> {
    std::fs::create_dir_all(directory)?;
    let path = activity_path(directory);
    let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    let value = json!(lines);
    std::fs::write(
        &temporary,
        format!("{}\n", crate::jsjson::stringify(&value)),
    )?;
    std::fs::rename(&temporary, path)
}

fn append_activity_line(lines: &mut Vec<String>, text: &str, append: bool) {
    if append && !lines.is_empty() {
        if let Some(last) = lines.last_mut() {
            last.push_str(text);
        }
    } else {
        lines.push(text.to_string());
    }
    trim_activity_lines(lines);
}

fn trim_activity_lines(lines: &mut Vec<String>) {
    let bytes = |line: &str| line.len();
    let total: usize = lines.iter().map(|line| bytes(line)).sum();
    if lines.len() <= ACTIVITY_MAX_ENTRIES && total <= ACTIVITY_MAX_BYTES {
        return;
    }
    let marker_bytes = bytes(ACTIVITY_TRIMMED_MARKER);
    let mut kept: Vec<String> = Vec::new();
    let mut kept_bytes = marker_bytes;
    for line in lines.iter().rev() {
        let size = bytes(line);
        let entries = kept.len() + 2;
        if !kept.is_empty()
            && (entries > ACTIVITY_MAX_ENTRIES || kept_bytes + size > ACTIVITY_MAX_BYTES)
        {
            break;
        }
        kept.insert(0, line.clone());
        kept_bytes += size;
    }
    lines.clear();
    lines.push(ACTIVITY_TRIMMED_MARKER.to_string());
    lines.extend(kept);
}

fn run_summary(run: &RunFile, activity: usize) -> RunSummary {
    RunSummary {
        run_id: run.run_id.clone(),
        status: run.status.clone(),
        started_at: run.started_at.clone(),
        finished_at: run.finished_at.clone(),
        exit_code: run.exit_code,
        issue_numbers: run.issues.iter().map(|issue| issue.number).collect(),
        activity,
        first_stderr_line: run.first_stderr_line.clone(),
        harness_version: run.harness_version.clone(),
        worker_pid: Some(run.worker_pid),
    }
}

fn list_run_directories(state_dir: &Path, repo_dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(runs_directory(state_dir, repo_dir))
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names.reverse();
    names
}

/* ------------------------------------------------------------------------ */
/* Ledger                                                                    */
/* ------------------------------------------------------------------------ */

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandledIssue {
    pub number: u64,
    #[serde(alias = "run_id")]
    pub run_id: String,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
struct Ledger {
    version: u64,
    handled: BTreeMap<String, HandledIssue>,
}

impl Ledger {
    fn empty() -> Self {
        Self {
            version: LEDGER_VERSION,
            handled: BTreeMap::new(),
        }
    }
}

fn parse_ledger(text: &str) -> Option<Ledger> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    let object = parsed.as_object()?;
    if object.get("version").and_then(Value::as_u64) != Some(LEDGER_VERSION) {
        return None;
    }
    let handled = object.get("handled")?.as_object()?;
    let mut entries = BTreeMap::new();
    for (key, value) in handled {
        let entry: HandledIssue = serde_json::from_value(value.clone()).ok()?;
        entries.insert(key.clone(), entry);
    }
    Some(Ledger {
        version: LEDGER_VERSION,
        handled: entries,
    })
}

fn load_ledger(state_dir: &Path, repo_dir: &Path) -> Ledger {
    let path = ledger_path(state_dir, repo_dir);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ledger::empty();
    };
    match parse_ledger(&text) {
        Some(ledger) => ledger,
        None => {
            let _ = std::fs::rename(
                &path,
                PathBuf::from(format!(
                    "{}.invalid-{}",
                    path.display(),
                    iso_now().replace([':', '.'], "-")
                )),
            );
            Ledger::empty()
        }
    }
}

/// The removed systemd orchestrator's records, read only for migration.
fn legacy_directory(state_dir: &Path) -> PathBuf {
    state_dir.join("orchestrator")
}

fn legacy_state_path(state_dir: &Path) -> PathBuf {
    legacy_directory(state_dir).join("state.json")
}

fn legacy_ledger_path(state_dir: &Path) -> PathBuf {
    legacy_directory(state_dir).join("ledger.json")
}

fn legacy_root_matches(state_dir: &Path, repo_dir: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(legacy_state_path(state_dir)) else {
        return false;
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    let Some(root) = parsed.get("root").and_then(Value::as_str) else {
        return false;
    };
    absolute(Path::new(root)) == absolute(repo_dir)
}

/// Copies the legacy handled numbers into the repository-keyed ledger, but only
/// when that ledger does not exist yet, the legacy state parses, and its root
/// names this checkout. Missing, damaged, or mismatched legacy files are
/// ignored; the legacy bytes are never rewritten.
pub fn migrate_legacy_ledger(
    state_dir: &Path,
    repo_dir: &Path,
    now: &str,
) -> Option<Vec<HandledIssue>> {
    if ledger_path(state_dir, repo_dir).exists() {
        return None;
    }
    if !legacy_root_matches(state_dir, repo_dir) {
        return None;
    }
    let text = std::fs::read_to_string(legacy_ledger_path(state_dir)).ok()?;
    let ledger = parse_ledger(&text)?;
    Some(
        ledger
            .handled
            .into_values()
            .map(|entry| HandledIssue {
                number: entry.number,
                run_id: entry.run_id,
                at: if entry.at.is_empty() {
                    now.to_string()
                } else {
                    entry.at
                },
            })
            .collect(),
    )
}

fn write_ledger(state_dir: &Path, repo_dir: &Path, ledger: &Ledger) -> std::io::Result<()> {
    let path = ledger_path(state_dir, repo_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    let value = serde_json::to_value(ledger).unwrap_or(Value::Null);
    std::fs::write(&temporary, format!("{}\n", pretty_json(&value)))?;
    std::fs::rename(&temporary, path)
}

fn prune_ledger(ledger: &Ledger, open: &HashSet<u64>) -> Option<Ledger> {
    let mut handled = BTreeMap::new();
    for (key, entry) in &ledger.handled {
        if open.contains(&entry.number) {
            handled.insert(key.clone(), entry.clone());
        }
    }
    (handled.len() != ledger.handled.len()).then_some(Ledger {
        version: LEDGER_VERSION,
        handled,
    })
}

fn record_handled(ledger: &Ledger, issues: &[Issue], run_id: &str, at: &str) -> Ledger {
    let mut handled = ledger.handled.clone();
    for issue in issues {
        handled.insert(
            issue.number.to_string(),
            HandledIssue {
                number: issue.number,
                run_id: run_id.to_string(),
                at: at.to_string(),
            },
        );
    }
    Ledger {
        version: LEDGER_VERSION,
        handled,
    }
}

/* ------------------------------------------------------------------------ */
/* Self-close records                                                        */
/* ------------------------------------------------------------------------ */

pub fn record_closed_by_run(state_dir: &Path, repo_dir: &Path, number: u64, run_id: &str) {
    let directory = closed_by_run_directory(state_dir, repo_dir);
    let _ = std::fs::create_dir_all(&directory);
    let path = directory.join(format!("{number}.json"));
    let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    if std::fs::write(&temporary, format!("{{\"runId\":\"{run_id}\"}}\n")).is_ok() {
        let _ = std::fs::rename(&temporary, &path);
    }
}

fn closed_by_run(state_dir: &Path, repo_dir: &Path, number: u64) -> Option<String> {
    let text = std::fs::read_to_string(
        closed_by_run_directory(state_dir, repo_dir).join(format!("{number}.json")),
    )
    .ok()?;
    let parsed: Value = serde_json::from_str(&text).ok()?;
    parsed
        .get("runId")
        .and_then(Value::as_str)
        .filter(|run_id| !run_id.is_empty())
        .map(str::to_string)
}

fn clear_closed_by_run(state_dir: &Path, repo_dir: &Path, number: u64, run_id: &str) {
    if closed_by_run(state_dir, repo_dir, number).as_deref() != Some(run_id) {
        return;
    }
    let _ = std::fs::remove_file(
        closed_by_run_directory(state_dir, repo_dir).join(format!("{number}.json")),
    );
}

/* ------------------------------------------------------------------------ */
/* Forge adapter                                                             */
/* ------------------------------------------------------------------------ */

/// One conditional read of the origin's open, non-pull-request issues.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackerReadRequest {
    pub repository: String,
    pub etag: Option<String>,
}

/// The answer of one tracker read.
#[derive(Debug, Clone, PartialEq)]
pub enum PollResult {
    Issues {
        issues: Vec<Issue>,
        etag: Option<String>,
    },
    NotModified {
        etag: Option<String>,
    },
    RateLimited {
        until: String,
        detail: String,
    },
    Error {
        detail: String,
    },
    Unsupported {
        detail: String,
    },
}

pub type TrackerReadFuture = Pin<Box<dyn Future<Output = PollResult> + Send>>;
pub type TrackerRead = Arc<dyn Fn(TrackerReadRequest) -> TrackerReadFuture + Send + Sync>;

fn forge_cli_environment(environment: &HashMap<String, String>) -> HashMap<String, String> {
    let mut env = environment.clone();
    for (key, value) in [
        ("GH_PROMPT_DISABLED", "1"),
        ("GH_NO_UPDATE_NOTIFIER", "1"),
        ("GIT_TERMINAL_PROMPT", "0"),
        ("NO_COLOR", "1"),
    ] {
        env.insert(key.into(), value.into());
    }
    env
}

fn first_line_of(text: &str) -> Option<String> {
    text.split('\n')
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

/// Reads the origin's open issues through the operator's credential.
fn map_poll_result(result: crate::forge::PollResult) -> PollResult {
    match result {
        crate::forge::PollResult::Issues { issues, etag } => PollResult::Issues {
            issues: issues
                .into_iter()
                .map(|issue| Issue {
                    number: issue.number.max(0) as u64,
                    title: issue.title,
                    url: issue.url,
                    created_at: issue.created_at,
                    labels: issue.labels,
                    body: Some(issue.body),
                })
                .collect(),
            etag,
        },
        crate::forge::PollResult::NotModified { etag } => PollResult::NotModified { etag },
        crate::forge::PollResult::RateLimited { until, detail } => {
            PollResult::RateLimited { until, detail }
        }
        crate::forge::PollResult::Error { detail } => PollResult::Error { detail },
        crate::forge::PollResult::Unsupported { detail } => PollResult::Unsupported { detail },
    }
}

/// The dashboard's own origin read.
fn production_tracker_read(
    repo_dir: PathBuf,
    environment: HashMap<String, String>,
    timeout_ms: u64,
) -> TrackerRead {
    Arc::new(move |request: TrackerReadRequest| {
        let repo_dir = repo_dir.clone();
        let environment = environment.clone();
        Box::pin(async move {
            let remote = crate::forge::origin_forge_with(&repo_dir, &environment);
            let forge = remote
                .as_ref()
                .map(|remote| remote.forge)
                .unwrap_or(crate::forge::Forge::GitHub);
            let base_url = crate::forge::gitea_base_url(remote.as_ref(), &environment);
            let options = crate::forge::TrackerOptions {
                forge,
                repository: request.repository,
                etag: request.etag,
                run: None,
                environment,
                timeout_ms: Some(timeout_ms),
                base_url,
                transport: None,
            };
            map_poll_result(crate::forge::poll_open_issues(&options).await)
        }) as TrackerReadFuture
    })
}

/* ------------------------------------------------------------------------ */
/* Tracker sync                                                              */
/* ------------------------------------------------------------------------ */

/// The sync status the Issues snapshot publishes for the Overview.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncView {
    interval_ms: u64,
    last_sync_at: Option<String>,
    error: Option<String>,
}

/// One read's outcome as the bridge consumes it.
#[derive(Debug, Clone)]
struct SyncResult {
    fresh: bool,
    issues: Option<Vec<Issue>>,
    started_at: Option<String>,
}

#[derive(Debug, Default)]
struct SyncInner {
    etag: Option<String>,
    issues: Option<Vec<Issue>>,
    last_sync_at: Option<String>,
    fresh_start: Option<String>,
    error: Option<String>,
    unsupported: Option<(String, String)>,
    in_flight: bool,
    generation: u64,
    last_result: Option<SyncResult>,
}

struct TrackerSync {
    read: TrackerRead,
    repository: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    interval_ms: u64,
    timeout_ms: u64,
    inner: Mutex<SyncInner>,
    notify: tokio::sync::Notify,
}

impl TrackerSync {
    fn new(
        read: TrackerRead,
        repository: Arc<dyn Fn() -> Option<String> + Send + Sync>,
        interval_ms: u64,
        timeout_ms: u64,
    ) -> Self {
        Self {
            read,
            repository,
            interval_ms,
            timeout_ms,
            inner: Mutex::new(SyncInner::default()),
            notify: tokio::sync::Notify::new(),
        }
    }

    fn view(&self) -> SyncView {
        let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        SyncView {
            interval_ms: self.interval_ms,
            last_sync_at: inner.last_sync_at.clone(),
            error: inner.error.clone(),
        }
    }

    fn open_issues(&self) -> Option<Vec<Issue>> {
        let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        inner.issues.clone()
    }

    fn unsupported_detail(&self) -> Option<String> {
        let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        inner.unsupported.as_ref().map(|(detail, _)| detail.clone())
    }

    fn repository_name(&self) -> Option<String> {
        (self.repository)()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    }

    /// Reads the tracker once; a read already in flight is joined.
    async fn sync(&self) -> SyncResult {
        let start_generation = {
            let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            inner.generation
        };
        loop {
            let notified = self.notify.notified();
            {
                let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
                if !inner.in_flight {
                    if let Some(terminal) = self.terminal_result(&mut inner) {
                        return terminal;
                    }
                    if inner.generation != start_generation {
                        return inner.last_result.clone().unwrap_or(SyncResult {
                            fresh: false,
                            issues: inner.issues.clone(),
                            started_at: None,
                        });
                    }
                    inner.in_flight = true;
                    break;
                }
            }
            notified.await;
        }
        let result = self.read_once().await;
        {
            let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            inner.in_flight = false;
            inner.generation = inner.generation.wrapping_add(1);
            inner.last_result = Some(result.clone());
        }
        self.notify.notify_waiters();
        result
    }

    fn terminal_result(&self, inner: &mut SyncInner) -> Option<SyncResult> {
        let (_detail, repository) = inner.unsupported.clone()?;
        if self.repository_name().as_deref() != Some(repository.as_str()) {
            inner.unsupported = None;
            return None;
        }
        Some(SyncResult {
            fresh: false,
            issues: inner.issues.clone(),
            started_at: None,
        })
    }

    async fn read_once(&self) -> SyncResult {
        let Some(repository) = self.repository_name() else {
            let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            return SyncResult {
                fresh: false,
                issues: inner.issues.clone(),
                started_at: None,
            };
        };
        let started_at = iso_now();
        let etag = {
            let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            inner.etag.clone()
        };
        let pending = (self.read)(TrackerReadRequest {
            repository: repository.clone(),
            etag,
        });
        let result = crate::deadline::within_deadline(pending, self.timeout_ms).await;
        let Some(result) = result else {
            let detail = format!("the tracker did not answer within {} ms", self.timeout_ms);
            let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            inner.error = Some(detail.clone());
            return SyncResult {
                fresh: false,
                issues: inner.issues.clone(),
                started_at: Some(started_at),
            };
        };
        let now = iso_now();
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        match result {
            PollResult::Issues { issues, etag } => {
                inner.etag = etag;
                inner.issues = Some(issues.clone());
                inner.fresh_start = Some(started_at.clone());
                inner.last_sync_at = Some(now);
                inner.error = None;
                SyncResult {
                    fresh: true,
                    issues: Some(issues),
                    started_at: Some(started_at),
                }
            }
            PollResult::NotModified { etag } => {
                inner.etag = etag;
                inner.last_sync_at = Some(now);
                inner.error = None;
                SyncResult {
                    fresh: false,
                    issues: inner.issues.clone(),
                    started_at: Some(started_at),
                }
            }
            PollResult::Unsupported { detail } => {
                inner.unsupported = Some((detail.clone(), repository));
                inner.error = Some(detail.clone());
                SyncResult {
                    fresh: false,
                    issues: inner.issues.clone(),
                    started_at: Some(started_at),
                }
            }
            PollResult::Error { detail } | PollResult::RateLimited { detail, .. } => {
                inner.error = Some(detail.clone());
                SyncResult {
                    fresh: false,
                    issues: inner.issues.clone(),
                    started_at: Some(started_at),
                }
            }
        }
    }
}

/* ------------------------------------------------------------------------ */
/* Seams                                                                     */
/* ------------------------------------------------------------------------ */

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreflightRequest {
    pub repo_dir: PathBuf,
    pub state_dir: PathBuf,
    pub environment: HashMap<String, String>,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreflightResult {
    Ok { repository: String },
    Refused { message: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloseIssueRequest {
    pub repo_dir: PathBuf,
    pub repository: String,
    pub number: u64,
    pub environment: HashMap<String, String>,
}

pub type PreflightFuture = Pin<Box<dyn Future<Output = PreflightResult> + Send>>;
pub type PreflightFn = Arc<dyn Fn(PreflightRequest) -> PreflightFuture + Send + Sync>;
pub type CloseFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;
pub type CloseFn = Arc<dyn Fn(CloseIssueRequest) -> CloseFuture + Send + Sync>;
pub type SpawnFn = Arc<dyn Fn(&[String], &HashMap<String, String>) -> Option<u32> + Send + Sync>;
pub type EnvironmentFuture =
    Pin<Box<dyn Future<Output = Result<HashMap<String, String>, String>> + Send>>;
pub type EnvironmentFn = Arc<dyn Fn() -> EnvironmentFuture + Send + Sync>;
pub type SendFn = Arc<dyn Fn(Value, Option<u64>) + Send + Sync>;

/// Everything one dashboard bridge needs from its process.
#[derive(Clone)]
pub struct IssuesHooks {
    pub preflight: PreflightFn,
    pub spawn_worker: SpawnFn,
    pub close_issue: CloseFn,
    pub tracker_read: TrackerRead,
    pub agent_environment: EnvironmentFn,
}

/// The legacy systemd orchestrator's lock, read only for migration.
fn legacy_live_lock(state_dir: &Path) -> Option<LockOwner> {
    let path = state_dir.join("orchestrator").join("lock");
    let owner = read_lock(&path)?;
    pid_alive(owner.pid).then_some(owner)
}

fn legacy_lock_refusal(owner: &LockOwner, state_dir: &Path) -> String {
    let path = state_dir.join("orchestrator").join("lock");
    format!(
        "the legacy devboard-orchestrator still holds {} (pid {}). Stop it with 'systemctl --user stop devboard-orchestrator.service', disable it with 'systemctl --user disable devboard-orchestrator.service', remove '$HOME/.config/systemd/user/devboard-orchestrator.service', then run 'systemctl --user daemon-reload'.",
        path.display(),
        owner.pid
    )
}

fn find_on_path(name: &str, environment: &HashMap<String, String>) -> Option<PathBuf> {
    crate::forge::find_on_path(name, environment)
}

fn omp_command_paths(repo_dir: &Path, environment: &HashMap<String, String>) -> Vec<PathBuf> {
    let home = environment
        .get("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_default();
    vec![
        repo_dir.join(".omp").join("commands"),
        repo_dir.join(".omp").join("agent").join("commands"),
        home.join(".omp").join("commands"),
        home.join(".omp").join("agent").join("commands"),
    ]
}

/// Everything Start must prove before it spawns a worker.
async fn production_preflight(request: PreflightRequest) -> PreflightResult {
    if let Some(problem) = crate::forge::root_problem(&request.repo_dir) {
        return PreflightResult::Refused { message: problem };
    }
    let remote = crate::forge::origin_forge_with(&request.repo_dir, &request.environment);
    let Some(remote) = remote else {
        return PreflightResult::Refused {
            message: "the checkout's origin does not name a supported repository".to_string(),
        };
    };
    if remote.forge == crate::forge::Forge::GitLab {
        return PreflightResult::Refused {
            message: format!(
                "the issues console supports a GitHub or Gitea origin, not a GitLab one: {}",
                remote.host
            ),
        };
    }
    let repository = remote.project.clone();
    if let Some(legacy) = legacy_live_lock(&request.state_dir) {
        return PreflightResult::Refused {
            message: legacy_lock_refusal(&legacy, &request.state_dir),
        };
    }
    if find_on_path("omp", &request.environment).is_none() {
        return PreflightResult::Refused {
            message: "missing prerequisite: omp is not on PATH".to_string(),
        };
    }
    if remote.forge == crate::forge::Forge::GitHub
        && find_on_path("gh", &request.environment).is_none()
    {
        return PreflightResult::Refused {
            message: "missing prerequisite: gh is not on PATH".to_string(),
        };
    }
    let commands: Vec<PathBuf> = omp_command_paths(&request.repo_dir, &request.environment)
        .into_iter()
        .map(|directory| directory.join("implement-issue.md"))
        .collect();
    if !commands.iter().any(|path| path.exists()) {
        return PreflightResult::Refused {
            message: format!(
                "missing prerequisite: the /implement-issue command is not installed for omp (looked in {}); install the harness wrappers with .devboard/install.sh",
                commands
                    .iter()
                    .map(|path| path.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        };
    }
    let goal_commands: Vec<PathBuf> = omp_command_paths(&request.repo_dir, &request.environment)
        .into_iter()
        .map(|directory| directory.join("implement-goal-issue.md"))
        .collect();
    if !goal_commands.iter().any(|path| path.exists()) {
        return PreflightResult::Refused {
            message: format!(
                "missing prerequisite: the /implement-goal-issue command is not installed for omp (looked in {}); install the harness wrappers with .devboard/install.sh",
                goal_commands
                    .iter()
                    .map(|path| path.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        };
    }
    if remote.forge == crate::forge::Forge::Gitea {
        let Some(base_url) = crate::forge::gitea_base_url(Some(&remote), &request.environment)
        else {
            return PreflightResult::Refused {
                message: "missing prerequisite: the Gitea address is not configured (set DEVBOARD_GITEA_URL or use an HTTP(S) origin)".to_string(),
            };
        };
        let Some(token) = crate::forge::configured_gitea_token(&request.environment) else {
            return PreflightResult::Refused {
                message: "missing prerequisite: GITEA_TOKEN is not set".to_string(),
            };
        };
        let target = match crate::forge::gitea_target(
            Some(&remote),
            Some(&repository),
            Some(&base_url),
            Some(&token),
            &request.environment,
        ) {
            Ok(target) => target,
            Err(error) => {
                return PreflightResult::Refused {
                    message: format!("missing prerequisite: {}", error.message),
                }
            }
        };
        let transport = crate::forge::default_transport(crate::forge::GITEA_REQUEST_TIMEOUT_MS);
        match crate::forge::gitea_repository(
            &target,
            &transport,
            &crate::forge::GiteaCallOptions::default(),
        )
        .await
        {
            Ok(document) => {
                let permissions = document.permissions().cloned().unwrap_or(Value::Null);
                let writable = permissions.get("push").and_then(Value::as_bool) == Some(true)
                    || permissions.get("admin").and_then(Value::as_bool) == Some(true);
                if !writable {
                    return PreflightResult::Refused {
                        message: format!(
                            "missing prerequisite: the Gitea token cannot write to {repository} on {base_url}"
                        ),
                    };
                }
                PreflightResult::Ok { repository }
            }
            Err(error) => PreflightResult::Refused {
                message: format!(
                    "missing prerequisite: the Gitea repository {repository} could not be read: {}",
                    error.message
                ),
            },
        }
    } else {
        let exec = crate::forge::default_exec();
        let options = crate::forge::ExecOptions {
            cwd: Some(request.repo_dir.clone()),
            env: forge_cli_environment(&request.environment),
            timeout_ms: Some(request.timeout_ms.max(1)),
            stdin: None,
        };
        let outcome = exec(
            "gh".to_string(),
            vec![
                "api".to_string(),
                format!("repos/{repository}"),
                "--jq".to_string(),
                ".permissions.push".to_string(),
            ],
            options,
        )
        .await;
        if outcome.killed && outcome.code == -1 {
            return PreflightResult::Refused {
                message: format!(
                    "missing prerequisite: 'gh api repos/{repository} --jq .permissions.push' did not finish within {} ms",
                    request.timeout_ms
                ),
            };
        }
        if outcome.code != 0 || outcome.stdout.trim() != "true" {
            let detail = first_line_of(&outcome.stderr)
                .or_else(|| first_line_of(&outcome.stdout))
                .unwrap_or_else(|| format!("gh exited with code {}", outcome.code));
            return PreflightResult::Refused {
                message: format!(
                    "missing prerequisite: 'gh api repos/{repository} --jq .permissions.push' did not return true: {detail}"
                ),
            };
        }
        PreflightResult::Ok { repository }
    }
}

/// Closes one issue as `not planned` on the checkout's own forge origin.
async fn production_close_issue(request: CloseIssueRequest) -> Result<(), String> {
    let remote = crate::forge::origin_forge_with(&request.repo_dir, &request.environment);
    let forge = remote
        .as_ref()
        .map(|remote| remote.forge)
        .unwrap_or(crate::forge::Forge::GitHub);
    // A close runs with a write-capable account, exactly like the TypeScript
    // bridge: resolve the credential first, then perform the forge mutation.
    let host = remote
        .as_ref()
        .map(|remote| remote.host.clone())
        .unwrap_or_else(|| "github.com".to_string());
    let mut resolve = crate::forge::ResolveOptions::new(
        forge,
        host,
        request.repository.clone(),
        request.repo_dir.clone(),
    );
    resolve.required = crate::forge::RequiredAccess::Write;
    resolve.env = request.environment.clone();
    resolve.deadline_ms =
        Some(crate::forge::now_millis() + crate::forge::DEFAULT_COMMAND_TIMEOUT_MS as i64);
    resolve.base_url = crate::forge::gitea_base_url(remote.as_ref(), &request.environment);
    let exec = crate::forge::default_exec();
    let resolved = crate::forge::with_forge_deadline(
        crate::forge::resolve_forge_auth(&exec, &resolve),
        crate::forge::DEFAULT_COMMAND_TIMEOUT_MS,
        "resolving the forge credential",
    )
    .await
    .map_err(|error| error.message)?;
    resolved
        .into_result()
        .map_err(|failure| first_line_of(&failure.error).unwrap_or(failure.error))?;
    if forge == crate::forge::Forge::GitLab {
        // `glab` has no issue-close reason and must never fall through to `gh`.
        return run_forge_close(
            "glab",
            vec![
                "issue".to_string(),
                "close".to_string(),
                request.number.to_string(),
                "--repo".to_string(),
                request.repository.clone(),
            ],
            &request,
        )
        .await;
    }
    // The shared forge client performs the forge's own close; `gh`/`glab`
    // argv and the Gitea PATCH live there.
    let mut options = crate::forge::ForgeIssuesOptions::new(&request.repo_dir);
    options.environment = request.environment.clone();
    let client = crate::forge::ForgeIssuesClient::new(options).map_err(|error| error.message)?;
    client
        .close(request.number as i64, crate::forge::CloseReason::NotPlanned)
        .await
        .map(|_| ())
        .map_err(|error| {
            format!(
                "Could not close issue #{}: {}",
                request.number,
                first_line_of(&error.message).unwrap_or_else(|| "no diagnostic".to_string())
            )
        })
}

async fn run_forge_close(
    command: &str,
    args: Vec<String>,
    request: &CloseIssueRequest,
) -> Result<(), String> {
    let exec = crate::forge::default_exec();
    let options = crate::forge::ExecOptions {
        cwd: Some(request.repo_dir.clone()),
        env: forge_cli_environment(&request.environment),
        timeout_ms: Some(crate::forge::DEFAULT_COMMAND_TIMEOUT_MS),
        stdin: None,
    };
    let outcome = exec(command.to_string(), args, options).await;
    if outcome.killed && outcome.code == -1 {
        return Err(format!(
            "closing issue #{} timed out after {} ms; retry the request.",
            request.number,
            crate::forge::DEFAULT_COMMAND_TIMEOUT_MS
        ));
    }
    if outcome.code == 0 {
        return Ok(());
    }
    let detail = if outcome.stderr.trim().is_empty() {
        &outcome.stdout
    } else {
        &outcome.stderr
    };
    Err(format!(
        "Could not close issue #{}: {}",
        request.number,
        first_line_of(detail).unwrap_or_else(|| "no diagnostic".to_string())
    ))
}

/// The detached worker's argv: this binary's own worker entry point.
fn worker_argv(repo_dir: &Path, state_dir: &Path) -> Vec<String> {
    vec![
        crate::relaunch::own_program().display().to_string(),
        "worker".to_string(),
        "issues".to_string(),
        "--repo".to_string(),
        repo_dir.display().to_string(),
        "--state-dir".to_string(),
        state_dir.display().to_string(),
    ]
}

fn production_spawn(
    argv: &[String],
    environment: &HashMap<String, String>,
    repo_dir: &Path,
    state_dir: &Path,
) -> Option<u32> {
    crate::supervision::supervised_detach(
        argv,
        crate::supervision::SupervisedDetachOptions {
            cwd: repo_dir.to_path_buf(),
            env: environment.clone(),
            state_dir: Some(state_dir.to_path_buf()),
            stdio: crate::supervision::DetachStdio::ignore(),
            on_error: Some(Box::new(|error: &std::io::Error| {
                eprintln!("could not start the issues worker: {error}");
            })),
        },
    )
}

/* ------------------------------------------------------------------------ */
/* Bridge                                                                    */
/* ------------------------------------------------------------------------ */

/// The answer of one Start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartOutcome {
    /// Attached: a live worker already serves this checkout.
    Started { attached: bool },
    /// The start was refused, naming the missing fact.
    Refused { message: String },
}

impl StartOutcome {
    pub fn is_ok(&self) -> bool {
        matches!(self, Self::Started { .. })
    }

    pub fn message(&self) -> Option<&str> {
        match self {
            Self::Started { .. } => None,
            Self::Refused { message } => Some(message),
        }
    }
}

/// Everything a dashboard bridge needs.
#[derive(Clone)]
pub struct IssuesOptions {
    pub repo_dir: PathBuf,
    pub state_dir: PathBuf,
    pub agent_command: String,
    pub running_version: Option<String>,
    pub environment: HashMap<String, String>,
    pub hooks: IssuesHooks,
    pub send: SendFn,
    pub has_clients: Arc<dyn Fn() -> bool + Send + Sync>,
    pub poll_ms: u64,
    pub sync_ms: u64,
    pub preflight_timeout_ms: u64,
    /// Called after each fresh open-issue read, never on a failure.
    pub on_open_issues: Arc<dyn Fn(Vec<Issue>) + Send + Sync>,
}

impl IssuesOptions {
    /// Builds the production hooks for one checkout.
    pub fn production_hooks(
        repo_dir: &Path,
        state_dir: &Path,
        agent_environment: EnvironmentFn,
    ) -> IssuesHooks {
        let environment = crate::forge::process_environment();
        let repo = repo_dir.to_path_buf();
        let state = state_dir.to_path_buf();
        IssuesHooks {
            preflight: Arc::new(|request: PreflightRequest| {
                Box::pin(production_preflight(request))
            }),
            spawn_worker: Arc::new(move |argv: &[String], env: &HashMap<String, String>| {
                production_spawn(argv, env, &repo, &state)
            }),
            close_issue: Arc::new(|request: CloseIssueRequest| {
                Box::pin(production_close_issue(request))
            }),
            tracker_read: production_tracker_read(
                repo_dir.to_path_buf(),
                environment,
                TRACKER_TIMEOUT_MS,
            ),
            agent_environment,
        }
    }
}

#[derive(Default)]
struct BridgeInner {
    last_signature: String,
    last_activities: HashMap<String, Vec<String>>,
    run_versions: HashMap<String, Option<String>>,
    stopping: HashMap<u32, u64>,
    abandoned: HashSet<String>,
    started: bool,
    sync_stopped: bool,
    /// When the supervisor last tried to replace a vanished worker.
    resume_attempt: Option<std::time::Instant>,
    /// A Start this dashboard accepted whose stop proof, preflight, or spawn
    /// still runs. It is answered before any of that work, so the page learns
    /// the start is in flight instead of waiting on a forge read.
    starting: bool,
    /// Why the last accepted Start spawned nothing. Cleared by the next
    /// accepted Start, so a refusal never outlives the attempt it answered.
    start_error: Option<String>,
}

/// The dashboard half of Issues mode.
pub struct IssuesBridge {
    repo_dir: PathBuf,
    canonical_repo_dir: PathBuf,
    state_dir: PathBuf,
    agent_command: String,
    running_version: Option<String>,
    environment: HashMap<String, String>,
    hooks: IssuesHooks,
    /// A Start preflight a test installed, answering instead of the hooks'.
    /// A test drives a slow preflight without a forge or an `omp` install.
    preflight_override: Mutex<Option<PreflightFn>>,
    send: SendFn,
    has_clients: Arc<dyn Fn() -> bool + Send + Sync>,
    poll_ms: u64,
    preflight_timeout_ms: u64,
    /// Monotonic millis since process start at which a page last read the
    /// Issues resource, or -1 before any read. The REST transport keeps no
    /// persistent command socket, so a page's polls are what make it a
    /// watching client.
    demand_at: AtomicI64,
    /// Monotonic millis since process start at which this dashboard last
    /// started a tracker read, or -1 before any read, so a page polling once a
    /// second cannot outpace the sync interval.
    read_at: AtomicI64,
    on_open_issues: Arc<dyn Fn(Vec<Issue>) + Send + Sync>,
    tracker: TrackerSync,
    repository_cache: Arc<Mutex<Option<(Option<String>, std::time::Instant)>>>,
    inner: Mutex<BridgeInner>,
    start_lock: tokio::sync::Mutex<()>,
    /// The accepted Start whose background work may still run. A Stop, and
    /// every accepted Start, moves it, so a continuation abandoned by either
    /// never publishes an outcome for an attempt it no longer owns.
    start_generation: AtomicU64,
    stop_sequence: AtomicU64,
    /// Set by an operator Stop; cleared by an operator Start. A supervisor
    /// never overrides either decision.
    auto_resume_suspended: AtomicBool,
}

fn newest_state(state_dir: &Path, repo_dir: &Path) -> Option<IssuesState> {
    let mut states = Vec::new();
    if let Some(state) = read_state(&state_path(state_dir, repo_dir)) {
        states.push(state);
    }
    for directory in worker_state_directories(state_dir, repo_dir) {
        if let Some(state) = read_state(&directory.join("state.json")) {
            states.push(state);
        }
    }
    states.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    states.into_iter().next()
}

impl IssuesBridge {
    pub fn new(options: IssuesOptions) -> Arc<Self> {
        let repo_dir = absolute(&options.repo_dir);
        let canonical_repo_dir =
            std::fs::canonicalize(&repo_dir).unwrap_or_else(|_| repo_dir.clone());
        let state_dir = absolute(&options.state_dir);
        let cache: Arc<Mutex<Option<(Option<String>, std::time::Instant)>>> =
            Arc::new(Mutex::new(None));
        let cache_for_read = Arc::clone(&cache);
        let repo_for_cache = repo_dir.clone();
        let state_for_cache = state_dir.clone();
        let environment_for_cache = options.environment.clone();
        let repository_fn: Arc<dyn Fn() -> Option<String> + Send + Sync> = Arc::new(move || {
            // The worker's published repository first, then the checkout's
            // origin, read only when this directory is the checkout root.
            if let Some(state) = newest_state(&state_for_cache, &repo_for_cache) {
                if !state.repo.is_empty() {
                    return Some(state.repo);
                }
            }
            let top = crate::forge::top_level(&repo_for_cache);
            let own_root = top
                .as_deref()
                .map(|top| absolute(Path::new(top)) == repo_for_cache)
                .unwrap_or(false);
            if !own_root {
                return None;
            }
            let mut guard = cache_for_read
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if let Some((value, checked_at)) = guard.as_ref() {
                if checked_at.elapsed() < Duration::from_millis(10_000) {
                    return value.clone();
                }
            }
            let value =
                crate::forge::origin_repository_with(&repo_for_cache, &environment_for_cache);
            *guard = Some((value.clone(), std::time::Instant::now()));
            value
        });
        let tracker = TrackerSync::new(
            options.hooks.tracker_read.clone(),
            repository_fn,
            options.sync_ms.max(1),
            TRACKER_TIMEOUT_MS,
        );
        Arc::new(Self {
            repo_dir,
            canonical_repo_dir,
            state_dir,
            agent_command: options.agent_command,
            running_version: options.running_version,
            environment: options.environment,
            hooks: options.hooks,
            preflight_override: Mutex::new(None),
            send: options.send,
            has_clients: options.has_clients,
            poll_ms: options.poll_ms.max(50),
            preflight_timeout_ms: options.preflight_timeout_ms.max(1),
            demand_at: AtomicI64::new(-1),
            read_at: AtomicI64::new(-1),
            on_open_issues: options.on_open_issues,
            tracker,
            repository_cache: cache,
            inner: Mutex::new(BridgeInner::default()),
            start_lock: tokio::sync::Mutex::new(()),
            start_generation: AtomicU64::new(0),
            stop_sequence: AtomicU64::new(0),
            auto_resume_suspended: AtomicBool::new(false),
        })
    }

    pub fn repo_dir(&self) -> &Path {
        &self.repo_dir
    }

    /* ------------------------------------------------------------------ */
    /* Reading                                                             */
    /* ------------------------------------------------------------------ */

    fn all_states(&self) -> Vec<IssuesState> {
        let mut states = Vec::new();
        if let Some(state) = read_state(&state_path(&self.state_dir, &self.repo_dir)) {
            states.push(state);
        }
        for directory in worker_state_directories(&self.state_dir, &self.repo_dir) {
            if let Some(state) = read_state(&directory.join("state.json")) {
                states.push(state);
            }
        }
        states
    }

    fn current_state(&self) -> Option<IssuesState> {
        newest_state(&self.state_dir, &self.repo_dir)
    }

    fn owners(&self) -> Vec<LockOwner> {
        live_lock_owners(&lock_path(&self.repo_dir))
    }

    fn lock_owner(&self) -> Option<LockOwner> {
        self.owners().into_iter().next()
    }

    fn foreign_owner(&self, owner: &LockOwner) -> bool {
        absolute(Path::new(&owner.state_dir)) != self.state_dir
    }

    fn control_for(&self, owner: &LockOwner) -> PathBuf {
        if let Some(version) = owner.harness_version.as_deref() {
            let path = versioned_state_path(&self.state_dir, &self.repo_dir, Some(version));
            if path.exists() {
                return versioned_control_directory(&self.state_dir, &self.repo_dir, Some(version));
            }
        }
        control_directory(&self.state_dir, &self.repo_dir)
    }

    /// True when there is a worker state or a live lock to replay.
    pub fn present(&self) -> bool {
        self.current_state().is_some() || self.lock_owner().is_some()
    }

    fn automatic_drain(&self, owner: &LockOwner, state: &IssuesState) -> bool {
        match state.pause_source.as_deref() {
            Some("drain") => return true,
            Some("operator") => return false,
            _ => {}
        }
        if !state.paused {
            return false;
        }
        read_drain_marker(&drain_marker_path(
            &self.state_dir,
            &self.repo_dir,
            owner.harness_version.as_deref(),
        ))
        .map(|marker| marker.pid == owner.pid)
        .unwrap_or(false)
    }

    fn run_version(&self, run: &RunSummary) -> Option<String> {
        if let Some(version) = &run.harness_version {
            return Some(version.clone());
        }
        {
            let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            if let Some(cached) = inner.run_versions.get(&run.run_id) {
                return cached.clone();
            }
        }
        let path = run_file_path(&run_directory(&self.state_dir, &self.repo_dir, &run.run_id));
        let version = std::fs::read_to_string(path)
            .ok()
            .and_then(|text| parse_run_file(&text))
            .and_then(|record| record.harness_version);
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        inner
            .run_versions
            .insert(run.run_id.clone(), version.clone());
        version
    }

    /// The checkout's origin repository, as the worker publishes it or git
    /// reports it. `snapshot.repo` answers this even for a directory below the
    /// checkout root; only the tracker reader applies the root check.
    fn repository(&self) -> Option<String> {
        let mut guard = self
            .repository_cache
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some((value, checked_at)) = guard.as_ref() {
            if checked_at.elapsed() < Duration::from_millis(10_000) {
                return value.clone();
            }
        }
        let value = crate::forge::origin_repository(&self.repo_dir);
        *guard = Some((value.clone(), std::time::Instant::now()));
        value
    }

    pub fn open_issues(&self) -> Option<Vec<Issue>> {
        self.tracker.open_issues()
    }

    /* ------------------------------------------------------------------ */
    /* Snapshot                                                            */
    /* ------------------------------------------------------------------ */

    pub fn snapshot(&self) -> Value {
        let owners = self.owners();
        let attached_owners: Vec<LockOwner> = owners
            .iter()
            .filter(|owner| !self.foreign_owner(owner))
            .cloned()
            .collect();
        let states = self.all_states();
        let by_pid: HashMap<u32, IssuesState> = states
            .iter()
            .filter_map(|state| {
                state
                    .worker
                    .as_ref()
                    .map(|worker| (worker.pid, state.clone()))
            })
            .collect();
        let ownerless = states.iter().find(|state| state.worker.is_none()).cloned();
        let mut attached_pairs: Vec<(LockOwner, IssuesState, bool)> = Vec::new();
        for owner in &attached_owners {
            let state = by_pid
                .get(&owner.pid)
                .cloned()
                .or_else(|| ownerless.clone());
            if let Some(state) = state {
                let drained = self.automatic_drain(owner, &state);
                attached_pairs.push((owner.clone(), state, drained));
            }
        }
        let attached = !attached_owners.is_empty();
        let mut sorted = states.clone();
        sorted.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        let mut newest: Vec<IssuesState> = attached_pairs
            .iter()
            .map(|(_, state, _)| state.clone())
            .collect();
        newest.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        let drained_keys: HashSet<(Option<u32>, String)> = attached_pairs
            .iter()
            .filter(|(_, _, drained)| *drained)
            .map(|(_, state, _)| {
                (
                    state.worker.as_ref().map(|worker| worker.pid),
                    state.updated_at.clone(),
                )
            })
            .collect();
        let is_drained = |state: &IssuesState| {
            drained_keys.contains(&(
                state.worker.as_ref().map(|worker| worker.pid),
                state.updated_at.clone(),
            ))
        };
        let operator_paused: Vec<IssuesState> = newest
            .iter()
            .filter(|state| state.paused && !is_drained(state))
            .cloned()
            .collect();
        let live_states: Vec<IssuesState> = newest
            .iter()
            .filter(|state| state.lifecycle != "stopped")
            .cloned()
            .collect();
        let working = live_states
            .iter()
            .any(|state| state.lifecycle == "running" || !state.agents.is_empty());
        let lifecycle = if !attached || live_states.is_empty() {
            "stopped".to_string()
        } else if !operator_paused.is_empty() {
            if working {
                "pausing".to_string()
            } else {
                "paused".to_string()
            }
        } else if working {
            "running".to_string()
        } else if live_states.iter().any(|state| state.lifecycle == "idle") {
            "idle".to_string()
        } else if live_states.iter().any(|state| state.lifecycle == "failed") {
            "failed".to_string()
        } else {
            "paused".to_string()
        };
        let candidates: Vec<IssuesState> = if attached && !newest.is_empty() {
            newest.clone()
        } else {
            sorted.clone()
        };
        let active = operator_paused
            .first()
            .cloned()
            .or_else(|| {
                candidates
                    .iter()
                    .find(|state| state.lifecycle == "running")
                    .cloned()
            })
            .or_else(|| {
                candidates
                    .iter()
                    .find(|state| state.lifecycle == "idle")
                    .cloned()
            })
            .or_else(|| candidates.iter().find(|state| !is_drained(state)).cloned())
            .or_else(|| candidates.first().cloned());
        let repo = match active.as_ref() {
            Some(state) if !state.repo.is_empty() => Some(state.repo.clone()),
            _ => self.repository(),
        };
        let mut version_by_pid: HashMap<u32, Option<String>> = HashMap::new();
        for state in &states {
            if let Some(worker) = &state.worker {
                version_by_pid.insert(worker.pid, worker.harness_version.clone());
            }
        }
        for owner in &owners {
            version_by_pid
                .entry(owner.pid)
                .or_insert_with(|| owner.harness_version.clone());
        }
        let workers: Vec<Value> = attached_owners
            .iter()
            .map(|owner| {
                json!({
                    "pid": owner.pid,
                    "version": owner.harness_version,
                    "stateDir": owner.state_dir,
                    "lifecycle": by_pid
                        .get(&owner.pid)
                        .map(|state| state.lifecycle.clone())
                        .unwrap_or_else(|| "running".to_string()),
                })
            })
            .collect();
        let mut runs: Vec<RunSummary> = Vec::new();
        let mut seen_runs: HashSet<String> = HashSet::new();
        for state in &states {
            for run in &state.runs {
                if !seen_runs.insert(run.run_id.clone()) {
                    continue;
                }
                let mut run = run.clone();
                run.harness_version = self.run_version(&run).or_else(|| {
                    run.worker_pid
                        .and_then(|pid| version_by_pid.get(&pid).cloned().flatten())
                });
                runs.push(run);
            }
        }
        runs.sort_by(|left, right| right.started_at.cmp(&left.started_at));
        let mut cooldowns: BTreeMap<String, String> = BTreeMap::new();
        let mut agents: Vec<Value> = Vec::new();
        for (_, state, _) in &attached_pairs {
            for (key, value) in &state.cooldowns {
                cooldowns.insert(key.clone(), value.clone());
            }
            for agent in &state.agents {
                let mut agent_value = serde_json::to_value(agent).unwrap_or(Value::Null);
                let run_version =
                    runs.iter()
                        .find(|run| run.run_id == agent.run_id)
                        .and_then(|run| run.harness_version.clone())
                        .or_else(|| {
                            state.worker.as_ref().and_then(|worker| {
                                version_by_pid.get(&worker.pid).cloned().flatten()
                            })
                        });
                if let Some(object) = agent_value.as_object_mut() {
                    object.insert(
                        "harnessVersion".into(),
                        run_version.map(Value::String).unwrap_or(Value::Null),
                    );
                }
                agents.push(agent_value);
            }
        }
        let enabled = attached
            && !live_states.is_empty()
            && lifecycle != "stopped"
            && live_states.iter().any(|state| state.enabled);
        let paused = lifecycle == "pausing" || lifecycle == "paused";
        let worker = if attached && !attached_pairs.is_empty() {
            active.as_ref().and_then(|state| state.worker.clone())
        } else {
            None
        };
        let poll = active.as_ref().map(|state| state.poll.clone());
        // A deferral belongs to a worker this dashboard is attached to: the
        // line a stopped worker left behind describes nothing that still waits.
        let (last_error, last_exit_code, finished_at, notice, deferral, updated_at) =
            match active.as_ref() {
                Some(state) => (
                    state.last_error.clone(),
                    state.last_exit_code,
                    state.finished_at.clone(),
                    state
                        .notice
                        .as_deref()
                        .filter(|notice| !is_deferral_shaped(notice))
                        .map(str::to_string),
                    if attached && state.lifecycle != "stopped" {
                        state.deferral.clone()
                    } else {
                        None
                    },
                    Some(state.updated_at.clone()),
                ),
                None => (None, None, None, None, None, None),
            };
        // A Start this dashboard accepted is its own fact, not a worker's:
        // it exists before the spawned worker has published any state.
        let (starting, start_error) = {
            let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            (inner.starting, inner.start_error.clone())
        };
        let mut map = Map::new();
        map.insert(
            "present".into(),
            Value::Bool(!states.is_empty() || !owners.is_empty()),
        );
        map.insert(
            "repo".into(),
            repo.map(Value::String).unwrap_or(Value::Null),
        );
        map.insert(
            "root".into(),
            Value::String(self.repo_dir.display().to_string()),
        );
        map.insert("lifecycle".into(), Value::String(lifecycle));
        map.insert("enabled".into(), Value::Bool(enabled));
        map.insert("paused".into(), Value::Bool(paused));
        map.insert("attached".into(), Value::Bool(attached));
        map.insert(
            "worker".into(),
            worker
                .map(|worker| serde_json::to_value(worker).unwrap_or(Value::Null))
                .unwrap_or(Value::Null),
        );
        map.insert(
            "poll".into(),
            poll.map(|poll| serde_json::to_value(poll).unwrap_or(Value::Null))
                .unwrap_or(Value::Null),
        );
        map.insert(
            "queue".into(),
            Value::Array(
                self.queue_for()
                    .into_iter()
                    .map(|issue| serde_json::to_value(issue).unwrap_or(Value::Null))
                    .collect(),
            ),
        );
        map.insert(
            "runs".into(),
            Value::Array(
                runs.into_iter()
                    .map(|run| serde_json::to_value(run).unwrap_or(Value::Null))
                    .collect(),
            ),
        );
        map.insert("agents".into(), Value::Array(agents));
        map.insert(
            "cooldowns".into(),
            Value::Object(
                cooldowns
                    .into_iter()
                    .map(|(key, value)| (key, Value::String(value)))
                    .collect(),
            ),
        );
        map.insert(
            "lastError".into(),
            last_error.map(Value::String).unwrap_or(Value::Null),
        );
        map.insert(
            "lastExitCode".into(),
            last_exit_code
                .map(|value| json!(value))
                .unwrap_or(Value::Null),
        );
        map.insert(
            "finishedAt".into(),
            finished_at.map(Value::String).unwrap_or(Value::Null),
        );
        map.insert(
            "notice".into(),
            notice.map(Value::String).unwrap_or(Value::Null),
        );
        map.insert(
            "deferral".into(),
            deferral.map(Value::String).unwrap_or(Value::Null),
        );
        map.insert("starting".into(), Value::Bool(starting));
        map.insert(
            "startError".into(),
            start_error.map(Value::String).unwrap_or(Value::Null),
        );
        map.insert(
            "updatedAt".into(),
            updated_at.map(Value::String).unwrap_or(Value::Null),
        );
        map.insert("workers".into(), Value::Array(workers));
        map.insert(
            "sync".into(),
            serde_json::to_value(self.tracker.view()).unwrap_or(Value::Null),
        );
        Value::Object(map)
    }

    /// The Open issues list: exactly the open issues one forge read returned.
    fn queue_for(&self) -> Vec<QueuedIssue> {
        let Some(open) = self.tracker.open_issues() else {
            return Vec::new();
        };
        let mut rows: Vec<QueuedIssue> = open
            .iter()
            .map(|issue| QueuedIssue::from_issue(issue, None, None))
            .collect();
        rows.sort_by_key(|issue| issue.number);
        rows
    }

    fn active_run_ids(&self, snapshot: &Value) -> Vec<String> {
        let mut ids: Vec<String> = Vec::new();
        if let Some(agents) = snapshot.get("agents").and_then(Value::as_array) {
            for agent in agents {
                if let Some(run_id) = agent.get("runId").and_then(Value::as_str) {
                    if !ids.iter().any(|id| id == run_id) {
                        ids.push(run_id.to_string());
                    }
                }
            }
        }
        ids
    }

    fn entries(activity: &[String]) -> Value {
        Value::Array(
            activity
                .iter()
                .map(|text| json!({"text": text, "append": false}))
                .collect(),
        )
    }

    fn read_activity(&self, run_id: &str) -> Vec<String> {
        read_activity(&run_directory(&self.state_dir, &self.repo_dir, run_id))
    }

    fn publish_activity(&self, run_id: &str, activity: Vec<String>) {
        let previous = {
            let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            inner.last_activities.get(run_id).cloned()
        };
        let Some(previous) = previous else {
            let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            inner
                .last_activities
                .insert(run_id.to_string(), activity.clone());
            drop(inner);
            (self.send)(
                self.activity_frame(run_id, true, Self::entries(&activity)),
                None,
            );
            return;
        };
        let delta = crate::activity::activity_delta(&previous, &activity);
        {
            let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            inner.last_activities.insert(run_id.to_string(), activity);
        }
        if !delta.replay && delta.entries.is_empty() {
            return;
        }
        let mut map = Map::new();
        map.insert("type".into(), Value::String("issuesActivity".into()));
        map.insert("runId".into(), Value::String(run_id.to_string()));
        if delta.replay {
            map.insert("replay".into(), Value::Bool(true));
        }
        map.insert(
            "entries".into(),
            Value::Array(delta.entries.iter().map(|entry| entry.to_json()).collect()),
        );
        (self.send)(Value::Object(map), None);
    }

    fn activity_frame(&self, run_id: &str, replay: bool, entries: Value) -> Value {
        let mut map = Map::new();
        map.insert("type".into(), Value::String("issuesActivity".into()));
        map.insert("runId".into(), Value::String(run_id.to_string()));
        if replay {
            map.insert("replay".into(), Value::Bool(true));
        }
        map.insert("entries".into(), entries);
        Value::Object(map)
    }

    /// Replays the state and every running agent's whole activity to one page.
    ///
    /// The replay reaches its target alone. Pushing a second copy of every
    /// running agent's whole activity at every other page is pure traffic:
    /// each of those pages reads it on its own next read.
    pub fn replay(&self, conn: &Conn) {
        self.demand_at.store(monotonic_millis(), Ordering::Relaxed);
        let snapshot = self.snapshot();
        conn.send(Self::typed_snapshot(snapshot.clone()));
        for run_id in self.active_run_ids(&snapshot) {
            let activity = self.read_activity(&run_id);
            {
                let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
                inner
                    .last_activities
                    .insert(run_id.clone(), activity.clone());
            }
            conn.send(self.activity_frame(&run_id, true, Self::entries(&activity)));
        }
    }

    /// Answers one action with the state alone.
    ///
    /// The worker's whole activity is replayed with a read or a connect
    /// ([`Self::replay`]), where it heals a page that missed a delta. An
    /// action's answer only confirms the change it made: one run's activity
    /// reaches 1 MiB, so replaying every running agent's log here made a
    /// Start's answer 32 MB on a dashboard with sixteen running agents.
    pub fn reply(&self, conn: &Conn) {
        conn.send(Self::typed_snapshot(self.snapshot()));
    }

    /// One snapshot with the frame type the page reads it by.
    fn typed_snapshot(snapshot: Value) -> Value {
        let mut frame = Map::new();
        frame.insert("type".into(), Value::String("issuesState".into()));
        if let Value::Object(snapshot_object) = snapshot {
            for (key, value) in snapshot_object {
                frame.insert(key, value);
            }
        }
        Value::Object(frame)
    }

    /// Recomputes the state and publishes a changed snapshot and activity.
    pub fn refresh(&self) {
        let snapshot = self.snapshot();
        let signature = crate::jsjson::stringify(&snapshot);
        let changed = {
            let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            if inner.last_signature == signature {
                false
            } else {
                inner.last_signature = signature;
                true
            }
        };
        if changed {
            (self.send)(Self::typed_snapshot(snapshot.clone()), None);
        }
        let run_ids = self.active_run_ids(&snapshot);
        let active: HashSet<&String> = run_ids.iter().collect();
        {
            let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            let stale: Vec<String> = inner
                .last_activities
                .keys()
                .filter(|run_id| !active.contains(run_id))
                .cloned()
                .collect();
            for run_id in stale {
                inner.last_activities.remove(&run_id);
            }
        }
        for run_id in run_ids {
            let activity = self.read_activity(&run_id);
            self.publish_activity(&run_id, activity);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Commands                                                            */
    /* ------------------------------------------------------------------ */

    pub async fn start(self: &Arc<Self>) -> StartOutcome {
        self.auto_resume_suspended.store(false, Ordering::SeqCst);
        let _guard = self.start_lock.lock().await;
        self.accept_start()
    }

    /// Accepts one Start and answers the state it changed, before the stop
    /// proof, the preflight, or the spawn runs.
    ///
    /// Both of those steps are slow by nature: the preflight reads the forge
    /// and the spawn starts a process. Holding an operator action's answer
    /// until they finish is what made a Start answer a second late, so the
    /// continuation runs in its own task and publishes its outcome as the
    /// snapshot's `startError` and a cleared `starting`.
    fn accept_start(self: &Arc<Self>) -> StartOutcome {
        let owners = self.owners();
        if let Some(foreign) = owners.iter().find(|owner| self.foreign_owner(owner)) {
            return StartOutcome::Refused {
                message: format!(
                    "this checkout already has an issues worker (pid {}) using {}; this dashboard's STATE_DIR is {}",
                    foreign.pid,
                    foreign.state_dir,
                    self.state_dir.display()
                ),
            };
        }
        let generation = {
            let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            let live = owners
                .iter()
                .any(|owner| !inner.stopping.contains_key(&owner.pid));
            if live {
                // A live worker already serves this checkout; the answer is
                // the state it is in, and nothing runs in the background.
                return StartOutcome::Started { attached: true };
            }
            if inner.starting {
                // Concurrent Starts share one preflight and spawn; a second
                // one is answered instead of starting a second worker.
                return StartOutcome::Started { attached: false };
            }
            inner.starting = true;
            inner.start_error = None;
            self.start_generation.fetch_add(1, Ordering::SeqCst) + 1
        };
        let bridge = Arc::clone(self);
        tokio::spawn(async move {
            let outcome = bridge.run_start(generation).await;
            bridge.finish_start(generation, outcome);
        });
        StartOutcome::Started { attached: false }
    }

    /// True once a Stop or a later Start owns the attempt `generation` named.
    fn start_superseded(&self, generation: u64) -> bool {
        self.start_generation.load(Ordering::SeqCst) != generation
    }

    /// The slow half of an accepted Start: wait out a stopping worker, run the
    /// preflight, then spawn.
    async fn run_start(self: &Arc<Self>, generation: u64) -> StartOutcome {
        loop {
            if self.start_superseded(generation) {
                return StartOutcome::Started { attached: false };
            }
            let owners = self.owners();
            if owners.is_empty() {
                break;
            }
            if let Some(foreign) = owners.iter().find(|owner| self.foreign_owner(owner)) {
                return StartOutcome::Refused {
                    message: format!(
                        "this checkout already has an issues worker (pid {}) using {}; this dashboard's STATE_DIR is {}",
                        foreign.pid,
                        foreign.state_dir,
                        self.state_dir.display()
                    ),
                };
            }
            let stopping: HashSet<u32> = {
                let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
                inner.stopping.keys().copied().collect()
            };
            let live: Vec<&LockOwner> = owners
                .iter()
                .filter(|owner| !stopping.contains(&owner.pid))
                .collect();
            if !live.is_empty() {
                // A worker appeared while this start waited: it attaches, and
                // the state it publishes answers the page.
                return StartOutcome::Started { attached: true };
            }
            let pids: Vec<u32> = owners.iter().map(|owner| owner.pid).collect();
            let mut all_stopped = true;
            for pid in &pids {
                if !self.wait_for_stop(*pid).await {
                    all_stopped = false;
                }
                if self.start_superseded(generation) {
                    return StartOutcome::Started { attached: false };
                }
            }
            if !all_stopped {
                return StartOutcome::Refused {
                    message: format!(
                        "the previous issues worker (pid {}) is still stopping; press Start once it has exited.",
                        pids.iter()
                            .map(u32::to_string)
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                };
            }
        }
        if self.start_superseded(generation) {
            return StartOutcome::Started { attached: false };
        }
        match self.preflight().await {
            Ok(()) => {}
            Err(message) => return StartOutcome::Refused { message },
        }
        if self.start_superseded(generation) {
            return StartOutcome::Started { attached: false };
        }
        self.spawn().await
    }

    /// Publishes one accepted Start's outcome to every page.
    fn finish_start(&self, generation: u64, outcome: StartOutcome) {
        if self.start_superseded(generation) {
            return;
        }
        let error = outcome.message().map(str::to_string);
        {
            let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            inner.starting = false;
            inner.start_error = error.clone();
        }
        if let Some(message) = &error {
            eprintln!("could not start the issues worker: {message}");
        }
        self.refresh();
    }

    /// Forgets an accepted Start a Stop has superseded, so the state names no
    /// start that no longer runs. True when one was still pending.
    fn cancel_start(&self) -> bool {
        let pending = {
            let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            let pending = inner.starting;
            inner.starting = false;
            inner.start_error = None;
            pending
        };
        if pending {
            self.start_generation.fetch_add(1, Ordering::SeqCst);
            self.refresh();
        }
        pending
    }

    /// Replaces an enabled worker that vanished without an operator Stop or
    /// Pause. The dashboard calls this on its supervisor tick; tests call it
    /// directly so the decision is deterministic.
    pub async fn supervise_once(self: &Arc<Self>) -> bool {
        if self.auto_resume_suspended.load(Ordering::SeqCst) {
            return false;
        }
        if !self.owners().is_empty() {
            return false;
        }
        let Some(state) = self.current_state() else {
            return false;
        };
        // A drain is the newest version's retirement of this worker, not an
        // operator stop: when no worker is live the newest version adopts the
        // family. Without this a drain whose replacement never started leaves
        // the queue stopped with every slot free.
        let drained = state.pause_source.as_deref() == Some("drain");
        if !drained && (!state.enabled || state.paused || state.lifecycle == "stopped") {
            return false;
        }
        {
            let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            if !inner.stopping.is_empty() {
                return false;
            }
            if let Some(last) = inner.resume_attempt {
                if last.elapsed() < Duration::from_millis(AUTO_RESUME_BACKOFF_MS) {
                    return false;
                }
            }
            inner.resume_attempt = Some(std::time::Instant::now());
        }
        if let StartOutcome::Refused { message } = self.start().await {
            eprintln!("could not restart the issues worker: {message}");
        }
        true
    }

    /// Runs the start preflight inside its deadline.
    async fn preflight(&self) -> Result<(), String> {
        let request = PreflightRequest {
            repo_dir: self.repo_dir.clone(),
            state_dir: self.state_dir.clone(),
            environment: self.environment.clone(),
            timeout_ms: self.preflight_timeout_ms,
        };
        let override_preflight = self
            .preflight_override
            .lock()
            .ok()
            .and_then(|slot| slot.clone());
        let pending = match override_preflight {
            Some(callback) => callback(request),
            None => (self.hooks.preflight)(request),
        };
        let result = crate::deadline::within_deadline(pending, self.preflight_timeout_ms).await;
        let Some(result) = result else {
            return Err(format!(
                "the start preflight did not finish within {} ms; press Start to retry.",
                self.preflight_timeout_ms
            ));
        };
        match result {
            PreflightResult::Refused { message } => Err(message),
            PreflightResult::Ok { .. } => Ok(()),
        }
    }

    /// Runs the start preflight, then spawns this version's worker.
    ///
    /// Both an operator Start and the newest-version takeover start through
    /// here, so a replacement never spawns without the preflight an operator
    /// Start would run.
    async fn preflight_and_spawn(self: &Arc<Self>) -> StartOutcome {
        match self.preflight().await {
            Ok(()) => self.spawn().await,
            Err(message) => StartOutcome::Refused { message },
        }
    }

    async fn wait_for_stop(&self, pid: u32) -> bool {
        let deadline = std::time::Instant::now() + Duration::from_millis(STOP_DEADLINE_MS);
        while pid_alive(pid) && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(STOP_POLL_MS)).await;
        }
        !pid_alive(pid)
    }

    async fn spawn(self: &Arc<Self>) -> StartOutcome {
        let argv = worker_argv(&self.repo_dir, &self.state_dir);
        let base = match (self.hooks.agent_environment)().await {
            Ok(environment) => environment,
            Err(message) => return StartOutcome::Refused { message },
        };
        let mut environment = base;
        environment.insert("REPO_DIR".into(), self.repo_dir.display().to_string());
        environment.insert("STATE_DIR".into(), self.state_dir.display().to_string());
        environment.insert("AGENT_COMMAND".into(), self.agent_command.clone());
        if let Some(version) = &self.running_version {
            environment.insert("DEVBOARD_HARNESS_VERSION".into(), version.clone());
        }
        match (self.hooks.spawn_worker)(&argv, &environment) {
            Some(_pid) => StartOutcome::Started { attached: false },
            None => StartOutcome::Refused {
                message: "the issues worker could not be started".to_string(),
            },
        }
    }

    pub fn command(self: &Arc<Self>, command: &IssuesCommand) -> Result<(), String> {
        // An operator Stop is remembered before the worker is reached, so a
        // worker that dies in the same instant is still not restarted.
        if matches!(command, IssuesCommand::Stop) {
            self.auto_resume_suspended.store(true, Ordering::SeqCst);
            // A Stop also supersedes a Start whose preflight or spawn has not
            // finished: that start is forgotten and answers no worker.
            if self.cancel_start() {
                return Ok(());
            }
        }
        let owners = self.owners();
        if owners.is_empty() {
            return Err("No issues worker is running for this checkout.".to_string());
        }
        if let Some(foreign) = owners.iter().find(|owner| self.foreign_owner(owner)) {
            return Err(format!(
                "the issues worker (pid {}) uses {}; this dashboard's STATE_DIR is {}",
                foreign.pid,
                foreign.state_dir,
                self.state_dir.display()
            ));
        }
        if let IssuesCommand::Answer { run_id, .. } = command {
            let Some(run_id) = run_id.clone().filter(|run_id| !run_id.is_empty()) else {
                return Err("An answer needs its run id.".to_string());
            };
            let target = owners.iter().find(|owner| {
                self.state_for_owner(owner)
                    .map(|state| state.agents.iter().any(|agent| agent.run_id == run_id))
                    .unwrap_or(false)
            });
            let Some(target) = target else {
                return Err(format!("No agent is running for run {run_id}."));
            };
            return write_command(&self.control_for(target), command)
                .map_err(|error| error.to_string());
        }
        for owner in &owners {
            write_command(&self.control_for(owner), command).map_err(|error| error.to_string())?;
            if matches!(command, IssuesCommand::Stop) {
                self.schedule_stop_proof(owner.pid);
            }
        }
        Ok(())
    }

    fn state_for_owner(&self, owner: &LockOwner) -> Option<IssuesState> {
        if let Some(version) = owner.harness_version.as_deref() {
            if let Some(state) = read_state(&versioned_state_path(
                &self.state_dir,
                &self.repo_dir,
                Some(version),
            )) {
                return Some(state);
            }
        }
        read_state(&state_path(&self.state_dir, &self.repo_dir))
    }

    /// Closes one open issue on the tracker.
    pub async fn close_issue(&self, number: &Value) -> Result<(), String> {
        let Some(number_value) = positive_integer(number) else {
            return Err("Closing an issue needs a positive issue number.".to_string());
        };
        let repository = self
            .current_state()
            .map(|state| state.repo)
            .filter(|repo| !repo.is_empty())
            .or_else(|| self.repository());
        let Some(repository) = repository else {
            return Err("This checkout has no GitHub origin.".to_string());
        };
        (self.hooks.close_issue)(CloseIssueRequest {
            repo_dir: self.repo_dir.clone(),
            repository,
            number: number_value,
            environment: self.environment.clone(),
        })
        .await
    }

    fn schedule_stop_proof(self: &Arc<Self>, pid: u32) {
        let sequence = self.stop_sequence.fetch_add(1, Ordering::Relaxed) + 1;
        {
            let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            inner.stopping.insert(pid, sequence);
        }
        let bridge = Arc::clone(self);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(STOP_PROOF_MS)).await;
            if !bridge.still_stopping(pid, sequence) {
                return;
            }
            if !pid_alive(pid) || !bridge.proves_worker(pid) {
                bridge.clear_stop_proof(pid, sequence);
                return;
            }
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGTERM);
            }
            tokio::time::sleep(Duration::from_millis(STOP_KILL_GRACE_MS)).await;
            if !bridge.still_stopping(pid, sequence) {
                return;
            }
            if !pid_alive(pid) || !bridge.proves_worker(pid) {
                bridge.clear_stop_proof(pid, sequence);
                return;
            }
            bridge.clear_stop_proof(pid, sequence);
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGKILL);
            }
        });
    }

    fn still_stopping(&self, pid: u32, sequence: u64) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        inner.stopping.get(&pid) == Some(&sequence)
    }

    fn clear_stop_proof(&self, pid: u32, sequence: u64) {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if inner.stopping.get(&pid) == Some(&sequence) {
            inner.stopping.remove(&pid);
        }
    }

    fn proves_worker(&self, pid: u32) -> bool {
        let Ok(text) = std::fs::read_to_string(format!("/proc/{pid}/cmdline")) else {
            return false;
        };
        let argv: Vec<String> = text
            .split('\u{0}')
            .filter(|entry| !entry.is_empty())
            .map(str::to_string)
            .collect();
        let our_worker = argv
            .windows(2)
            .any(|pair| pair[0] == "worker" && pair[1] == "issues");
        let legacy_worker = argv.iter().any(|entry| entry.ends_with("issues/worker.ts"));
        if !our_worker && !legacy_worker {
            return false;
        }
        let repo = self.repo_dir.display().to_string();
        if !argv.iter().any(|entry| entry == &repo) {
            return false;
        }
        std::fs::read_link(format!("/proc/{pid}/cwd"))
            .map(|cwd| cwd == self.canonical_repo_dir)
            .unwrap_or(false)
    }

    pub fn run(&self, run_id: &Value) -> Option<Value> {
        let run_id = run_id.as_str()?;
        if run_id.is_empty()
            || !run_id
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-'))
        {
            return None;
        }
        let directory = run_directory(&self.state_dir, &self.repo_dir, run_id);
        let run = std::fs::read_to_string(run_file_path(&directory))
            .ok()
            .and_then(|text| parse_run_file(&text))?;
        let activity = self.read_activity(run_id);
        let summary = run_summary(&run, activity.len());
        let mut map = Map::new();
        for (key, value) in serde_json::to_value(&summary).ok()?.as_object()?.clone() {
            map.insert(key, value);
        }
        map.insert("repo".into(), Value::String(run.repo.clone()));
        map.insert(
            "argv".into(),
            Value::Array(run.argv.iter().cloned().map(Value::String).collect()),
        );
        map.insert("cwd".into(), Value::String(run.cwd.clone()));
        map.insert(
            "issues".into(),
            Value::Array(
                run.issues
                    .iter()
                    .map(|issue| serde_json::to_value(issue).unwrap_or(Value::Null))
                    .collect(),
            ),
        );
        map.insert("workerPid".into(), json!(run.worker_pid));
        map.insert(
            "harnessVersion".into(),
            run.harness_version
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
        map.insert(
            "activityLines".into(),
            Value::Array(activity.into_iter().map(Value::String).collect()),
        );
        Some(Value::Object(map))
    }

    /* ------------------------------------------------------------------ */
    /* Tracker sync and background loops                                   */
    /* ------------------------------------------------------------------ */

    /// Whether a page or socket client is watching the Issues surfaces.
    ///
    /// The REST transport opens no persistent command socket, so a page
    /// counts as watching while its own read of this resource is recent: it
    /// polls once a second, and one sync interval plus one poll covers a page
    /// that is still there. With neither a socket client nor a recent read the
    /// dashboard makes no tracker call.
    fn watching(&self) -> bool {
        if (self.has_clients)() {
            return true;
        }
        let last = self.demand_at.load(Ordering::Relaxed);
        last >= 0 && monotonic_millis().saturating_sub(last) <= self.demand_window_ms()
    }

    fn demand_window_ms(&self) -> i64 {
        (self.tracker.interval_ms as i64).saturating_add(CLIENT_POLL_MS)
    }

    /// Reads the tracker for a page that just asked for this resource.
    pub fn request_sync(self: &Arc<Self>) {
        let bridge = Arc::clone(self);
        tokio::spawn(async move { bridge.sync_now().await });
    }

    pub async fn sync_now(self: &Arc<Self>) {
        if !self.watching() {
            return;
        }
        // A page polls its resource once a second; the tracker is read once
        // per interval no matter how often a read arrives.
        let now = monotonic_millis();
        let previous = self.read_at.swap(now, Ordering::Relaxed);
        if previous >= 0 && now.saturating_sub(previous) < self.tracker.interval_ms as i64 {
            return;
        }
        let result = self.tracker.sync().await;
        if self.tracker.unsupported_detail().is_some() {
            let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            inner.sync_stopped = true;
        }
        if result.fresh {
            if let (Some(issues), Some(started_at)) = (&result.issues, &result.started_at) {
                if let Some(started) = parse_iso(started_at) {
                    let open: HashSet<u64> = issues.iter().map(|issue| issue.number).collect();
                    self.stop_closed_runs(&open, epoch_millis(started));
                }
            }
            if let Some(issues) = &result.issues {
                (self.on_open_issues)(issues.clone());
            }
        }
        self.refresh();
    }

    /// Ends every run the dashboard's fresh read no longer lists.
    fn stop_closed_runs(&self, open: &HashSet<u64>, read_started_at: i64) {
        let owners: Vec<LockOwner> = self
            .owners()
            .into_iter()
            .filter(|owner| !self.foreign_owner(owner))
            .collect();
        if owners.is_empty() {
            return;
        }
        let mut pending: HashSet<String> = HashSet::new();
        for owner in &owners {
            let Some(state) = self.state_for_owner(owner) else {
                continue;
            };
            if !state.enabled || state.lifecycle == "stopped" {
                continue;
            }
            let worker_poll_at = state
                .poll
                .last_poll_at
                .as_deref()
                .and_then(parse_iso)
                .map(epoch_millis);
            if state.poll.error.is_none()
                && worker_poll_at
                    .map(|at| at >= read_started_at)
                    .unwrap_or(false)
            {
                continue;
            }
            let eligible: Vec<&Agent> = state
                .agents
                .iter()
                .filter(|agent| !open.contains(&agent.issue_number))
                .filter(|agent| {
                    closed_by_run(&self.state_dir, &self.repo_dir, agent.issue_number).as_deref()
                        != Some(agent.run_id.as_str())
                })
                .filter(|agent| {
                    parse_iso(&agent.started_at)
                        .map(|started| epoch_millis(started) < read_started_at)
                        .unwrap_or(false)
                })
                .collect();
            for agent in &eligible {
                pending.insert(format!("{}:{}", agent.issue_number, agent.run_id));
            }
            for agent in eligible {
                let key = format!("{}:{}", agent.issue_number, agent.run_id);
                let already = {
                    let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
                    inner.abandoned.contains(&key)
                };
                if already {
                    continue;
                }
                match write_command(
                    &self.control_for(owner),
                    &IssuesCommand::Abandon {
                        number: agent.issue_number,
                    },
                ) {
                    Ok(()) => {
                        let mut inner =
                            self.inner.lock().unwrap_or_else(|error| error.into_inner());
                        inner.abandoned.insert(key);
                    }
                    Err(error) => eprintln!(
                        "could not ask the issues worker to stop #{}: {error}",
                        agent.issue_number
                    ),
                }
            }
        }
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let stale: Vec<String> = inner
            .abandoned
            .iter()
            .filter(|key| !pending.contains(*key))
            .cloned()
            .collect();
        for key in stale {
            inner.abandoned.remove(&key);
        }
    }

    /// Starts the dashboard's observation loops; it never starts a worker.
    pub fn begin(self: &Arc<Self>) {
        {
            let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            if inner.started {
                return;
            }
            inner.started = true;
        }
        let bridge = Arc::clone(self);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_millis(bridge.poll_ms));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                bridge.refresh();
            }
        });
        let bridge = Arc::clone(self);
        tokio::spawn(async move {
            let mut ticker =
                tokio::time::interval(Duration::from_millis(bridge.tracker.interval_ms.max(1)));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                let stopped = {
                    let inner = bridge
                        .inner
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    inner.sync_stopped
                };
                if stopped {
                    continue;
                }
                bridge.sync_now().await;
            }
        });
        let bridge = Arc::clone(self);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_millis(AUTO_RESUME_INTERVAL_MS));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                bridge.supervise_once().await;
            }
        });
        let bridge = Arc::clone(self);
        tokio::spawn(async move {
            bridge.takeover_old_workers().await;
        });
    }

    /// Starts this version's worker when an older live one is the newest.
    async fn takeover_old_workers(self: &Arc<Self>) {
        let owners: Vec<LockOwner> = self
            .owners()
            .into_iter()
            .filter(|owner| !self.foreign_owner(owner))
            .collect();
        if owners.is_empty() {
            return;
        }
        let newest =
            crate::version::read_harness_version(&crate::version::host_harness_dir(&self.repo_dir));
        if newest.is_none() || newest != self.running_version {
            return;
        }
        if owners
            .iter()
            .any(|owner| owner.harness_version == self.running_version)
        {
            return;
        }
        // A live owner of this version already serves the family; otherwise
        // this version starts its own worker before the older one drains, so
        // the queue keeps moving while the older worker finishes its units.
        let started = self.preflight_and_spawn().await;
        if let StartOutcome::Refused { message } = started {
            eprintln!(
                "could not start the {} issues worker: {message}",
                self.running_version.as_deref().unwrap_or("current")
            );
            return;
        }
        for owner in &owners {
            if owner.harness_version == self.running_version {
                continue;
            }
            let marker = DrainMarker {
                version: owner.harness_version.clone(),
                pid: owner.pid,
                by: self.running_version.clone(),
                at: iso_now(),
            };
            let marker_result = write_drain_marker(
                &drain_marker_path(
                    &self.state_dir,
                    &self.repo_dir,
                    owner.harness_version.as_deref(),
                ),
                &marker,
            );
            let command_result = write_command(&self.control_for(owner), &IssuesCommand::Drain);
            if let Err(error) = marker_result.and(command_result) {
                eprintln!(
                    "could not drain the {} issues worker: {error}",
                    owner.harness_version.as_deref().unwrap_or("legacy")
                );
            }
        }
    }
}

/// One JSON number that names a positive integer, as JavaScript counts them.
fn positive_integer(value: &Value) -> Option<u64> {
    if let Some(number) = value.as_u64() {
        return (number > 0).then_some(number);
    }
    let number = value.as_f64()?;
    if number.fract() != 0.0 || number < 1.0 || number > u64::MAX as f64 {
        return None;
    }
    Some(number as u64)
}

fn absolute(path: &Path) -> PathBuf {
    use std::path::Component;
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };
    let mut normalized = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

/* ------------------------------------------------------------------------ */
/* Mode wiring                                                               */
/* ------------------------------------------------------------------------ */

static BRIDGES: OnceLock<Mutex<Vec<(Weak<App>, Arc<IssuesBridge>)>>> = OnceLock::new();

fn registry() -> &'static Mutex<Vec<(Weak<App>, Arc<IssuesBridge>)>> {
    BRIDGES.get_or_init(|| Mutex::new(Vec::new()))
}

/// The bridge one application owns, when it has been initialised.
pub fn bridge_for(app: &Arc<App>) -> Option<Arc<IssuesBridge>> {
    let mut entries = registry().lock().unwrap_or_else(|error| error.into_inner());
    entries.retain(|(weak, _)| weak.strong_count() > 0);
    let target = Arc::as_ptr(app);
    entries.iter().find_map(|(weak, bridge)| {
        Weak::upgrade(weak)
            .filter(|candidate| Arc::as_ptr(candidate) == target)
            .map(|_| Arc::clone(bridge))
    })
}

/// Answers every later Start preflight with `callback` instead of the hooks'.
/// A test drives a slow preflight without a forge read or an `omp` install.
pub fn set_preflight(app: &Arc<App>, callback: PreflightFn) {
    if let Some(bridge) = bridge_for(app) {
        if let Ok(mut slot) = bridge.preflight_override.lock() {
            *slot = Some(callback);
        }
    }
}

/// The Issues gate: live runs are work a reset preempts.
struct IssuesGate {
    bridge: Weak<IssuesBridge>,
}

impl crate::app::ModeGate for IssuesGate {
    fn has_active_work(&self) -> bool {
        self.bridge
            .upgrade()
            .map(|bridge| {
                bridge
                    .snapshot()
                    .get("agents")
                    .and_then(Value::as_array)
                    .map(|agents| !agents.is_empty())
                    .unwrap_or(false)
            })
            .unwrap_or(false)
    }

    fn busy_reason(&self) -> Option<String> {
        None
    }

    fn abort_active_work(&self) {
        if let Some(bridge) = self.bridge.upgrade() {
            let _ = bridge.command(&IssuesCommand::Stop);
        }
    }
}

/// Registers this mode's state and starts its observation loops.
pub fn init(app: &Arc<App>) {
    let target = Arc::as_ptr(app);
    {
        let entries = registry().lock().unwrap_or_else(|error| error.into_inner());
        let exists = entries.iter().any(|(weak, _)| {
            Weak::upgrade(weak)
                .map(|candidate| Arc::as_ptr(&candidate) == target)
                .unwrap_or(false)
        });
        if exists {
            return;
        }
    }
    let weak_app = Arc::downgrade(app);
    let agent_environment: EnvironmentFn = Arc::new(move || {
        let weak_app = weak_app.clone();
        Box::pin(async move {
            let Some(app) = weak_app.upgrade() else {
                return Err("the dashboard has stopped".to_string());
            };
            let environment = app
                .providers
                .select_environment()
                .await
                .map_err(|error| error.message)?;
            let mut resolved = HashMap::new();
            for (key, value) in environment {
                if let Some(value) = value {
                    resolved.insert(key, value);
                }
            }
            Ok(resolved)
        }) as EnvironmentFuture
    });
    let repo_dir = app.config().repo_dir.clone();
    let state_dir = app.config().state_dir.clone();
    let environment = crate::forge::process_environment();
    let hooks = IssuesOptions::production_hooks(&repo_dir, &state_dir, agent_environment);
    let shared = Arc::clone(&app.shared);
    // Issues events are never part of the dashboard's durable state: the
    // TypeScript bridge sends them with `sendAll`, never `persistState`.
    let send: SendFn = Arc::new(move |event, except| shared.send_all(event, except));
    let clients = Arc::clone(&app.shared);
    let sync_ms = std::env::var("DEVBOARD_ISSUES_SYNC_INTERVAL_MS")
        .ok()
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| (value as u64).max(1_000))
        .unwrap_or(TRACKER_SYNC_INTERVAL_MS);
    let options = IssuesOptions {
        repo_dir,
        state_dir,
        agent_command: app.config().agent_command.clone(),
        running_version: app.running_version.clone(),
        environment,
        hooks,
        send,
        has_clients: Arc::new(move || clients.has_clients()),
        poll_ms: DASHBOARD_POLL_MS,
        sync_ms,
        preflight_timeout_ms: ISSUES_PREFLIGHT_TIMEOUT_MS,
        on_open_issues: {
            let weak_app = Arc::downgrade(app);
            Arc::new(move |issues: Vec<Issue>| {
                let Some(app) = weak_app.upgrade() else {
                    return;
                };
                let rows = issues
                    .into_iter()
                    .map(|issue| {
                        json!({
                            "number": issue.number,
                            "title": issue.title,
                            "url": issue.url,
                            "body": issue.body.unwrap_or_default(),
                        })
                    })
                    .collect();
                crate::agents_mode::publish_prompt_templates(&app, rows);
            })
        },
    };
    let bridge = IssuesBridge::new(options);
    {
        let mut entries = registry().lock().unwrap_or_else(|error| error.into_inner());
        entries.push((Arc::downgrade(app), Arc::clone(&bridge)));
    }
    app.shared.register_gate(
        "issues",
        Arc::new(IssuesGate {
            bridge: Arc::downgrade(&bridge),
        }),
    );
    bridge.begin();
}

/// Replays the frames a connecting client owes before its own replies.
pub fn replay(app: &Arc<App>, conn: &Conn) {
    let Some(bridge) = bridge_for(app) else {
        return;
    };
    bridge.replay(conn);
    // A fresh view reads the tracker immediately; the sync timer alone would
    // leave the first thirty seconds showing a stopped worker's list.
    bridge.request_sync();
}

fn issues_error(conn: &Conn, message: impl Into<String>) {
    conn.send(json!({"type": "error", "message": message.into()}));
}

/// Applies one command; `false` when it belongs to another mode.
pub async fn handle(app: &Arc<App>, conn: &Conn, command: &Command) -> bool {
    match command {
        Command::GetIssues => {
            if let Some(bridge) = bridge_for(app) {
                bridge.replay(conn);
                bridge.request_sync();
            }
            true
        }
        Command::GetIssuesRun { run_id } => {
            let missing = Value::Null;
            let detail =
                bridge_for(app).and_then(|bridge| bridge.run(run_id.as_ref().unwrap_or(&missing)));
            match detail {
                Some(run) => conn.send(json!({"type": "issuesRun", "run": run})),
                None => issues_error(conn, "No such issues run."),
            }
            true
        }
        Command::StartIssues => {
            let Some(bridge) = bridge_for(app) else {
                issues_error(conn, "No issues worker is running for this checkout.");
                return true;
            };
            match bridge.start().await {
                StartOutcome::Refused { message } => issues_error(conn, message),
                // The answer is the state the Start changed, written before
                // its preflight runs, and never the whole activity a page's
                // own read replays: one run's activity reaches 1 MiB, so the
                // action's answer waited on megabytes the page never needed to
                // render this change.
                StartOutcome::Started { .. } => bridge.reply(conn),
            }
            true
        }
        Command::PauseIssues
        | Command::ResumeIssues
        | Command::StopIssues
        | Command::CheckIssues => {
            let Some(bridge) = bridge_for(app) else {
                issues_error(conn, "No issues worker is running for this checkout.");
                return true;
            };
            let issues_command = match command {
                Command::PauseIssues => IssuesCommand::Pause,
                Command::ResumeIssues => IssuesCommand::Resume,
                Command::StopIssues => IssuesCommand::Stop,
                _ => IssuesCommand::Check,
            };
            if let Err(message) = bridge.command(&issues_command) {
                issues_error(conn, message);
            }
            true
        }
        Command::AnswerIssues { id, value, run_id } => {
            let Some(bridge) = bridge_for(app) else {
                issues_error(conn, "No issues worker is running for this checkout.");
                return true;
            };
            let Some(id) = id
                .as_ref()
                .filter(|id| id.is_number() || id.is_string())
                .cloned()
            else {
                issues_error(conn, "An answer needs its question id and value.");
                return true;
            };
            let Some(value) = value.as_ref().and_then(Value::as_str) else {
                issues_error(conn, "An answer needs its question id and value.");
                return true;
            };
            let Some(run_id) = run_id
                .as_ref()
                .and_then(Value::as_str)
                .filter(|run_id| !run_id.is_empty())
            else {
                issues_error(conn, "An answer needs its run id.");
                return true;
            };
            let answer = IssuesCommand::Answer {
                id,
                value: value.to_string(),
                run_id: Some(run_id.to_string()),
            };
            if let Err(message) = bridge.command(&answer) {
                issues_error(conn, message);
            }
            true
        }
        Command::CloseIssue { number } => {
            let Some(bridge) = bridge_for(app) else {
                issues_error(conn, "This checkout has no GitHub origin.");
                return true;
            };
            let Some(number) = number.as_ref().filter(|number| number.is_number()) else {
                issues_error(conn, "Closing an issue needs its number.");
                return true;
            };
            let number = number.clone();
            match bridge.close_issue(&number).await {
                Ok(()) => {
                    conn.send(json!({"type": "issuesClosed", "number": number, "ok": true}));
                    bridge.refresh();
                }
                Err(message) => conn.send(json!({
                    "type": "issuesClosed",
                    "number": number,
                    "ok": false,
                    "message": message,
                })),
            }
            true
        }
        _ => false,
    }
}

/* ------------------------------------------------------------------------ */
/* Worker                                                                    */
/* ------------------------------------------------------------------------ */

/// The issues worker's answer for one issue's tracker state.
#[derive(Debug, Clone, PartialEq, Eq)]
enum IssueStateResult {
    State { closed: bool },
    Error { detail: String },
}

#[derive(Debug, Clone)]
enum WorkerEvent {
    Activity {
        number: u64,
        entry: crate::acp::AcpActivity,
    },
    Question {
        number: u64,
        question: crate::acp::AcpQuestion,
    },
    SessionUpdate {
        number: u64,
    },
    Stderr {
        number: u64,
        text: String,
    },
    TurnEnded {
        number: u64,
        error: Option<String>,
    },
    FollowUpEnded {
        number: u64,
        error: Option<String>,
    },
    Verify {
        number: u64,
        result: IssueStateResult,
    },
}

struct FirstLine {
    buffer: String,
    found: bool,
    value: Option<String>,
}

impl FirstLine {
    fn new() -> Self {
        Self {
            buffer: String::new(),
            found: false,
            value: None,
        }
    }

    fn push(&mut self, chunk: &str) {
        if self.found {
            return;
        }
        self.buffer.push_str(chunk);
        let line = self
            .buffer
            .split('\n')
            .map(|entry| entry.trim_end())
            .find(|entry| !entry.trim().is_empty());
        if let Some(line) = line {
            self.found = true;
            self.value = Some(bounded_first_line(line.trim()));
            return;
        }
        if self.buffer.len() > FIRST_LINE_MAX * 8 {
            // The cut is a byte budget, so move it forward until it lands on a
            // code point boundary: a multibyte character straddling the budget
            // must not panic the worker.
            let mut start = self.buffer.len() - FIRST_LINE_MAX;
            while start < self.buffer.len() && !self.buffer.is_char_boundary(start) {
                start += 1;
            }
            self.buffer = self.buffer[start..].to_string();
        }
    }

    fn finish(&mut self) {
        if self.found {
            return;
        }
        let trimmed = self.buffer.trim();
        if trimmed.is_empty() {
            return;
        }
        self.value = Some(bounded_first_line(trimmed));
    }
}

fn bounded_first_line(line: &str) -> String {
    if line.chars().count() <= FIRST_LINE_MAX {
        line.to_string()
    } else {
        let mut kept: String = line.chars().take(FIRST_LINE_MAX - 1).collect();
        kept.push('…');
        kept
    }
}

struct WorkerActive {
    run_id: String,
    directory: PathBuf,
    started_at: String,
    issue: Issue,
    captured: Vec<Issue>,
    activity: Vec<String>,
    peer: Option<Arc<crate::acp::AcpConnection>>,
    first_line: FirstLine,
    turns: u32,
    settling: bool,
    finished: bool,
    last_signal: std::time::Instant,
}

struct RunEntry {
    run: RunFile,
    directory: PathBuf,
}

type IssueStateFn = Arc<dyn Fn(u64) -> IssueStateFuture + Send + Sync>;
type ProcessingFn = Arc<
    dyn Fn(u64, bool) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>> + Send + Sync,
>;

struct IssuesWorker {
    repo_dir: PathBuf,
    state_dir: PathBuf,
    interval_ms: u64,
    agent_command: String,
    environment: HashMap<String, String>,
    harness_version: Option<String>,
    state: IssuesState,
    ledger: Ledger,
    /// Numbers this worker pruned on the current poll; a shared ledger write
    /// must not resurrect them.
    pruned: HashSet<u64>,
    active: HashMap<u64, WorkerActive>,
    dismissed: HashMap<u64, std::time::Instant>,
    claiming: HashSet<u64>,
    claim_token: String,
    runs: Vec<RunEntry>,
    draining: bool,
    stopping: bool,
    polling: bool,
    next_poll_due: std::time::Instant,
    lock: Option<(PathBuf, String)>,
    last_saved: String,
    events: tokio::sync::mpsc::UnboundedSender<WorkerEvent>,
    receptor: tokio::sync::mpsc::UnboundedReceiver<WorkerEvent>,
    list_issues: TrackerRead,
    /// Test seams. Production leaves these empty and reads the tracker, the
    /// forge, and the process-wide governor through their real paths.
    issue_state_override: Option<IssueStateFn>,
    processing_override: Option<ProcessingFn>,
    governor_override: Option<Arc<crate::resources::Governor>>,
}

impl IssuesWorker {
    fn new(
        repo_dir: PathBuf,
        state_dir: PathBuf,
        interval_ms: u64,
        agent_command: String,
        environment: HashMap<String, String>,
        harness_version: Option<String>,
    ) -> Self {
        let (events, receptor) = tokio::sync::mpsc::unbounded_channel();
        let tracker =
            production_tracker_read(repo_dir.clone(), environment.clone(), TRACKER_TIMEOUT_MS);
        Self {
            repo_dir,
            state_dir,
            interval_ms: interval_ms.max(100),
            agent_command,
            environment,
            harness_version,
            state: empty_state("", "", 10_000, "stopped"),
            ledger: Ledger::empty(),
            pruned: HashSet::new(),
            active: HashMap::new(),
            dismissed: HashMap::new(),
            claiming: HashSet::new(),
            claim_token: format!("pending-{}-{}", std::process::id(), uuid::Uuid::new_v4()),
            runs: Vec::new(),
            draining: false,
            stopping: false,
            polling: false,
            next_poll_due: std::time::Instant::now(),
            lock: None,
            last_saved: String::new(),
            events,
            receptor,
            list_issues: tracker,
            issue_state_override: None,
            processing_override: None,
            governor_override: None,
        }
    }

    /* ------------------------------------------------------------------ */
    /* Start                                                               */
    /* ------------------------------------------------------------------ */

    fn start(&mut self, repository: &str) -> bool {
        let argv: Vec<String> = std::env::args().collect();
        let lock = match acquire_worker_lock(
            &self.repo_dir,
            self.harness_version.as_deref(),
            (
                &self.repo_dir,
                &self.state_dir,
                self.harness_version.clone(),
                argv,
            ),
        ) {
            Ok(owner) => owner,
            Err(Some(_)) => {
                eprintln!("issues: already running for {}", self.repo_dir.display());
                return false;
            }
            Err(None) => return false,
        };
        let token = std::fs::read_to_string(versioned_lock_path(
            &self.repo_dir,
            self.harness_version.as_deref(),
        ))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| {
            value
                .get("token")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default();
        let lock_path = versioned_lock_path(&self.repo_dir, self.harness_version.as_deref());
        self.lock = Some((lock_path, token));
        let _ = lock;

        let versioned = versioned_state_path(
            &self.state_dir,
            &self.repo_dir,
            self.harness_version.as_deref(),
        );
        let legacy = state_path(&self.state_dir, &self.repo_dir);
        let source = if versioned.exists() {
            versioned.clone()
        } else if legacy.exists() {
            legacy
        } else {
            versioned.clone()
        };
        let (loaded, text) = load_state_with_text(&source);
        let (previous_children, previous_runs) = previous_records(text.as_deref());
        self.ledger = load_ledger(&self.state_dir, &self.repo_dir);
        let mut migration_error: Option<String> = None;
        if let Some(migrated) = migrate_legacy_ledger(&self.state_dir, &self.repo_dir, &iso_now()) {
            if !migrated.is_empty() {
                for entry in migrated {
                    self.ledger.handled.insert(entry.number.to_string(), entry);
                }
                if let Err(error) = self.persist_ledger() {
                    migration_error = Some(error);
                }
                eprintln!(
                    "issues: migrated handled issues from the legacy orchestrator for {}",
                    self.repo_dir.display()
                );
            }
        }
        self.runs = load_runs(&self.state_dir, &self.repo_dir)
            .into_iter()
            .map(|(run, directory, _activity)| RunEntry { run, directory })
            .collect();
        for orphan in previous_children {
            if !recorded_child_alive(&orphan) {
                continue;
            }
            unsafe {
                libc::kill(orphan.pid as libc::pid_t, libc::SIGKILL);
            }
            eprintln!("issues: terminated orphaned ACP child {}", orphan.pid);
        }
        let mut interrupted: HashSet<String> = previous_runs.into_iter().collect();
        for entry in &self.runs {
            if entry.run.status == "running"
                && (entry.run.worker_pid == std::process::id()
                    || entry.run.harness_version == self.harness_version)
            {
                interrupted.insert(entry.run.run_id.clone());
            }
        }
        for run_id in interrupted {
            self.close_interrupted_run(&run_id);
        }
        self.active.clear();
        let now = iso_now();
        let mut state = empty_state(
            repository,
            &self.repo_dir.display().to_string(),
            self.interval_ms,
            "idle",
        );
        state.enabled = true;
        state.worker = Some(WorkerRecord {
            pid: std::process::id(),
            started_at: now.clone(),
            state_dir: self.state_dir.display().to_string(),
            harness_version: self.harness_version.clone(),
            argv: std::env::args().collect(),
        });
        state.runs = self.summaries();
        state.updated_at = now;
        if loaded.is_none() { /* a fresh state is published below */ }
        self.state = state;
        if let Some(error) = migration_error {
            self.state.last_error = Some(error);
        }
        self.next_poll_due = std::time::Instant::now();
        self.publish();
        true
    }

    fn close_interrupted_run(&mut self, run_id: &str) {
        let Some(entry) = self
            .runs
            .iter_mut()
            .find(|entry| entry.run.run_id == run_id)
        else {
            return;
        };
        entry.run.status = "stopped".to_string();
        entry.run.finished_at = Some(iso_now());
        entry.run.exit_code = None;
        let _ = write_run_file(&entry.directory, &entry.run);
    }

    fn summaries(&self) -> Vec<RunSummary> {
        self.runs
            .iter()
            .map(|entry| run_summary(&entry.run, read_activity(&entry.directory).len()))
            .collect()
    }

    fn publish(&mut self) {
        self.state.updated_at = iso_now();
        let value = serde_json::to_value(&self.state).unwrap_or(Value::Null);
        let text = crate::jsjson::stringify(&value);
        if text == self.last_saved {
            return;
        }
        let path = versioned_state_path(
            &self.state_dir,
            &self.repo_dir,
            self.harness_version.as_deref(),
        );
        match write_state(&path, &self.state) {
            Ok(()) => self.last_saved = text,
            Err(error) => eprintln!("issues: could not write state: {error}"),
        }
    }

    /* ------------------------------------------------------------------ */
    /* Ticker and events                                                   */
    /* ------------------------------------------------------------------ */

    async fn tick(&mut self) {
        if self.stopping {
            return;
        }
        self.consume_commands().await;
        if self.stopping || !self.state.enabled {
            return;
        }
        self.reclaim_silent_runs().await;
        if self.polling {
            return;
        }
        if self.draining && self.active.is_empty() && !self.polling {
            self.stop().await;
            return;
        }
        if std::time::Instant::now() < self.next_poll_due {
            return;
        }
        self.poll().await;
    }

    async fn consume_commands(&mut self) {
        let mut commands = take_commands(&control_directory(&self.state_dir, &self.repo_dir));
        commands.extend(take_commands(&versioned_control_directory(
            &self.state_dir,
            &self.repo_dir,
            self.harness_version.as_deref(),
        )));
        for command in commands {
            if self.stopping {
                return;
            }
            self.apply(command).await;
        }
    }

    async fn apply(&mut self, command: IssuesCommand) {
        match command {
            IssuesCommand::Pause => {
                self.state.paused = true;
                self.state.pause_source = Some("operator".into());
                self.state.notice = None;
                self.state.lifecycle = if self.active.is_empty() {
                    "paused".into()
                } else {
                    "pausing".into()
                };
                self.publish();
            }
            IssuesCommand::Resume => {
                self.state.paused = false;
                self.state.pause_source = None;
                self.state.notice = None;
                self.state.lifecycle = self.settled_lifecycle();
                self.next_poll_due = std::time::Instant::now();
                self.publish();
            }
            IssuesCommand::Check => {
                if self.state.paused {
                    self.state.notice = Some("Check now is unavailable while paused.".into());
                    self.publish();
                    return;
                }
                if !self.state.enabled {
                    self.state.notice = Some("Start the issues worker before checking now.".into());
                    self.publish();
                    return;
                }
                self.state.cooldowns.clear();
                self.state.notice = None;
                if self.state.lifecycle == "failed" {
                    self.state.lifecycle = "idle".into();
                }
                self.next_poll_due = std::time::Instant::now();
                self.publish();
            }
            IssuesCommand::Answer { id, value, run_id } => {
                let Some(run_id) = run_id.filter(|run_id| !run_id.is_empty()) else {
                    self.state.notice = Some("An answer needs its run id.".into());
                    self.publish();
                    return;
                };
                let number = self
                    .active
                    .iter()
                    .find(|(_, active)| active.run_id == run_id)
                    .map(|(number, _)| *number);
                let question = number.and_then(|_number| {
                    self.state
                        .agents
                        .iter()
                        .find(|agent| agent.run_id == run_id)
                        .and_then(|agent| agent.question.clone())
                });
                let Some(number) = number else {
                    self.state.notice =
                        Some("That question is no longer waiting for an answer.".into());
                    self.publish();
                    return;
                };
                let Some(question) = question else {
                    self.state.notice =
                        Some("That question is no longer waiting for an answer.".into());
                    self.publish();
                    return;
                };
                if question.id != id {
                    self.state.notice =
                        Some("That question is no longer waiting for an answer.".into());
                    self.publish();
                    return;
                }
                let Some(acp_id) = crate::acp::AcpId::from_value(&id) else {
                    self.state.notice =
                        Some("That question is no longer waiting for an answer.".into());
                    self.publish();
                    return;
                };
                let peer = self
                    .active
                    .get(&number)
                    .and_then(|active| active.peer.clone());
                let Some(peer) = peer else {
                    self.state.notice =
                        Some("That question is no longer waiting for an answer.".into());
                    self.publish();
                    return;
                };
                let answered = peer.answer(&acp_id, &value).await;
                if let Some(active) = self.active.get_mut(&number) {
                    active.last_signal = std::time::Instant::now();
                }
                if !answered {
                    self.state.notice =
                        Some("That question is no longer waiting for an answer.".into());
                    self.publish();
                    return;
                }
                for agent in &mut self.state.agents {
                    if agent.run_id == run_id {
                        agent.question = None;
                    }
                }
                self.state.notice = None;
                self.publish();
            }
            IssuesCommand::Abandon { number } => {
                // The run may have ended between the dashboard's read and this
                // command; a missing run is not an error.
                let Some(active) = self.active.get(&number) else {
                    return;
                };
                let notice =
                    format!("Issue #{number} was closed on the tracker; its run was stopped.");
                // A dashboard read is one observation, so a goal issue settles
                // only on a close the tracker proves.
                if is_goal_issue(&active.issue) {
                    self.settle_dropped_goal(number, notice).await;
                } else {
                    self.abandon_run(number, notice).await;
                }
            }
            IssuesCommand::Stop => {
                self.stop().await;
            }
            IssuesCommand::Drain => {
                self.draining = true;
                self.state.paused = true;
                self.state.pause_source = Some("drain".into());
                self.state.notice = None;
                self.state.lifecycle = if self.active.is_empty() {
                    "paused".into()
                } else {
                    "pausing".into()
                };
                self.publish();
            }
        }
    }

    fn cooldown_remaining(&self, number: u64) -> bool {
        let Some(until) = self.state.cooldowns.get(&number.to_string()) else {
            return false;
        };
        parse_iso(until)
            .map(|at| epoch_millis(at) > epoch_millis(OffsetDateTime::now_utc()))
            .unwrap_or(false)
    }

    fn settled_lifecycle(&self) -> String {
        if self.stopping {
            return "stopped".into();
        }
        if self.state.paused {
            return if self.active.is_empty() {
                "paused".into()
            } else {
                "pausing".into()
            };
        }
        if !self.active.is_empty() {
            return "running".into();
        }
        if !self.state.enabled {
            return "stopped".into();
        }
        let now = std::time::Instant::now();
        let unhandled = self
            .state
            .queue
            .iter()
            .filter(|issue| !issue.handled)
            .filter(|issue| {
                !self
                    .dismissed
                    .get(&issue.number)
                    .map(|until| *until > now)
                    .unwrap_or(false)
            })
            .count();
        if unhandled == 0 {
            "idle".into()
        } else {
            "failed".into()
        }
    }

    /* ------------------------------------------------------------------ */
    /* Polling                                                             */
    /* ------------------------------------------------------------------ */

    async fn poll(&mut self) {
        if self.polling || self.stopping {
            return;
        }
        self.polling = true;
        self.reclaim_silent_runs().await;
        let started_at = OffsetDateTime::now_utc();
        let etag = self.state.poll.etag.clone();
        let pending = (self.list_issues)(TrackerReadRequest {
            repository: self.state.repo.clone(),
            etag,
        });
        let result = crate::deadline::within_deadline(pending, TRACKER_TIMEOUT_MS).await;
        if self.stopping {
            self.polling = false;
            return;
        }
        match result {
            None => {
                let detail = format!("the tracker did not answer within {TRACKER_TIMEOUT_MS} ms");
                self.state.poll.last_poll_at = Some(iso(started_at));
                self.state.poll.error = Some(detail.clone());
                let next = started_at + time::Duration::milliseconds(self.interval_ms as i64);
                self.state.poll.next_poll_at = Some(iso(next));
                self.next_poll_due =
                    std::time::Instant::now() + Duration::from_millis(self.interval_ms);
                self.state.last_error = Some(detail);
                self.publish();
            }
            Some(result) => {
                self.state.poll.last_poll_at = Some(iso(started_at));
                let next_at = started_at + time::Duration::milliseconds(self.interval_ms as i64);
                match result {
                    PollResult::NotModified { etag } => {
                        self.state.poll.etag = etag;
                        self.state.poll.not_modified = true;
                        self.state.poll.error = None;
                        self.state.poll.rate_limited_until = None;
                        self.state.poll.next_poll_at = Some(iso(next_at));
                        self.next_poll_due =
                            std::time::Instant::now() + Duration::from_millis(self.interval_ms);
                        self.refresh_queue();
                    }
                    PollResult::Issues { issues, etag } => {
                        self.state.poll.etag = etag;
                        self.state.poll.not_modified = false;
                        self.state.poll.error = None;
                        self.state.poll.rate_limited_until = None;
                        self.state.poll.next_poll_at = Some(iso(next_at));
                        self.next_poll_due =
                            std::time::Instant::now() + Duration::from_millis(self.interval_ms);
                        self.reconcile_processing(&issues).await;
                        if self.stopping {
                            self.polling = false;
                            return;
                        }
                        self.apply_issues(issues).await;
                    }
                    PollResult::RateLimited { until, detail } => {
                        self.state.poll.error = Some(detail);
                        self.state.poll.rate_limited_until = Some(until.clone());
                        self.state.poll.next_poll_at = Some(until.clone());
                        if let Some(at) = parse_iso(&until) {
                            let now = OffsetDateTime::now_utc();
                            let delay = (epoch_millis(at) - epoch_millis(now)).max(0) as u64;
                            self.next_poll_due =
                                std::time::Instant::now() + Duration::from_millis(delay);
                        }
                    }
                    PollResult::Error { detail } | PollResult::Unsupported { detail } => {
                        self.state.poll.error = Some(detail.clone());
                        self.state.poll.next_poll_at = Some(iso(next_at));
                        self.next_poll_due =
                            std::time::Instant::now() + Duration::from_millis(self.interval_ms);
                        self.state.last_error = Some(detail);
                    }
                }
                self.publish();
                self.maybe_trigger().await;
            }
        }
        self.polling = false;
    }

    async fn reconcile_processing(&mut self, issues: &[Issue]) {
        let live: HashSet<u64> = live_issue_claims(&self.repo_dir)
            .into_iter()
            .map(|claim| claim.number)
            .collect();
        let active: HashSet<u64> = self.active.keys().copied().collect();
        let mut cleared: Vec<u64> = Vec::new();
        for issue in issues {
            if !crate::forge::has_processing_label(&issue.labels) {
                continue;
            }
            if live.contains(&issue.number) || active.contains(&issue.number) {
                continue;
            }
            match write_processing(
                &self.repo_dir,
                &self.state.repo,
                &self.environment,
                issue.number,
                false,
            )
            .await
            {
                Ok(()) => cleared.push(issue.number),
                Err(detail) => eprintln!(
                    "issues: could not clear the processing label on #{}: {detail}",
                    issue.number
                ),
            }
        }
        let _ = cleared;
    }

    async fn set_processing(&self, number: u64, active: bool) -> bool {
        let outcome = match &self.processing_override {
            Some(write) => write(number, active).await,
            None => {
                write_processing(
                    &self.repo_dir,
                    &self.state.repo,
                    &self.environment,
                    number,
                    active,
                )
                .await
            }
        };
        match outcome {
            Ok(()) => true,
            Err(detail) => {
                eprintln!(
                    "issues: could not {} issue #{} as processing: {detail}",
                    if active { "mark" } else { "unmark" },
                    number
                );
                false
            }
        }
    }

    /// Persists this worker's ledger without erasing another version's work.
    /// Another live worker shares the repository ledger, so the disk copy is
    /// merged: every entry it holds for an issue still open and not pruned by
    /// this pass survives, and this worker's own entry wins a collision.
    fn persist_ledger(&mut self) -> Result<(), String> {
        let disk = load_ledger(&self.state_dir, &self.repo_dir);
        let open: HashSet<u64> = self.state.queue.iter().map(|issue| issue.number).collect();
        let pruned = std::mem::take(&mut self.pruned);
        let mut handled = BTreeMap::new();
        for (key, entry) in disk.handled {
            if open.contains(&entry.number) && !pruned.contains(&entry.number) {
                handled.insert(key, entry);
            }
        }
        for (key, entry) in &self.ledger.handled {
            handled.insert(key.clone(), entry.clone());
        }
        self.ledger = Ledger {
            version: LEDGER_VERSION,
            handled,
        };
        write_ledger(&self.state_dir, &self.repo_dir, &self.ledger)
            .map_err(|error| format!("could not write the ledger: {error}"))
    }

    async fn apply_issues(&mut self, issues: Vec<Issue>) {
        let open: HashSet<u64> = issues.iter().map(|issue| issue.number).collect();
        let now = std::time::Instant::now();
        self.dismissed
            .retain(|number, until| open.contains(number) && *until > now);
        if let Some(pruned) = prune_ledger(&self.ledger, &open) {
            for key in self.ledger.handled.keys() {
                if !pruned.handled.contains_key(key) {
                    if let Ok(number) = key.parse::<u64>() {
                        self.pruned.insert(number);
                    }
                }
            }
            self.ledger = pruned;
            if let Err(error) = self.persist_ledger() {
                self.state.last_error = Some(error);
            }
        }
        self.state.cooldowns.retain(|key, _| {
            key.parse::<u64>()
                .map(|number| open.contains(&number))
                .unwrap_or(false)
        });
        self.state.queue = issues.iter().map(|issue| self.queued(issue)).collect();
        self.clear_resolved_error(&open);
        self.stop_closed_runs(&open).await;
    }

    fn error_issue(message: &str) -> Option<u64> {
        for prefix in ["the agent finished but issue #", "could not verify issue #"] {
            if let Some(rest) = message.strip_prefix(prefix) {
                let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
                if !digits.is_empty() {
                    return digits.parse().ok();
                }
            }
        }
        if let Some(rest) = message.strip_prefix("the agent produced no output for ") {
            if let Some(index) = rest.find("; issue #") {
                let tail = &rest[index + "; issue #".len()..];
                let digits: String = tail.chars().take_while(char::is_ascii_digit).collect();
                if !digits.is_empty() {
                    return digits.parse().ok();
                }
            }
        }
        if let Some(rest) = message.strip_prefix("the tracker dropped issue #") {
            let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
            if !digits.is_empty() {
                return digits.parse().ok();
            }
        }
        None
    }

    fn clear_resolved_error(&mut self, open: &HashSet<u64>) {
        let Some(message) = self.state.last_error.clone() else {
            return;
        };
        let Some(number) = Self::error_issue(&message) else {
            return;
        };
        if !open.contains(&number) {
            self.state.last_error = None;
        }
    }

    fn queued(&self, issue: &Issue) -> QueuedIssue {
        let handled = self.ledger.handled.get(&issue.number.to_string());
        QueuedIssue::from_issue(
            issue,
            handled,
            self.active
                .get(&issue.number)
                .map(|active| active.run_id.clone()),
        )
    }

    fn refresh_queue(&mut self) {
        let mut rows = Vec::new();
        for issue in &self.state.queue {
            let issue = Issue {
                number: issue.number,
                title: issue.title.clone(),
                url: issue.url.clone(),
                created_at: issue.created_at.clone(),
                labels: issue.labels.clone(),
                body: issue.body.clone(),
            };
            rows.push(self.queued(&issue));
        }
        self.state.queue = rows;
    }

    async fn maybe_trigger(&mut self) {
        if self.stopping || self.state.paused || !self.state.enabled {
            // Nothing is being deferred while no start is attempted, so a
            // line that claimed otherwise is stale and is dropped here.
            if self.state.deferral.take().is_some() {
                self.publish();
            }
            return;
        }
        let mut deferral: Option<String> = None;
        let queue = self.state.queue.clone();
        for issue in queue {
            if self.active.len() >= MAX_CONCURRENT_PEERS {
                break;
            }
            if issue.handled {
                continue;
            }
            if let Some(until) = self.dismissed.get(&issue.number) {
                if *until > std::time::Instant::now() {
                    continue;
                }
            }
            if self.active.contains_key(&issue.number) {
                continue;
            }
            if self.cooldown_remaining(issue.number) {
                continue;
            }
            if !claim_issue(
                &self.repo_dir,
                issue.number,
                &self.claim_token,
                self.harness_version.as_deref(),
            ) {
                continue;
            }
            self.claiming.insert(issue.number);
            let issue = Issue {
                number: issue.number,
                title: issue.title,
                url: issue.url,
                created_at: issue.created_at,
                labels: issue.labels,
                body: issue.body,
            };
            // The global cap admits this issue's peer before the run opens.
            // A deferral leaves the issue queued for the next tick; it is
            // never marked failed.
            let governor = self
                .governor_override
                .clone()
                .or_else(|| crate::resources::global().cloned());
            let permit = match governor {
                Some(governor) => {
                    let label = format!("issue #{}", issue.number);
                    match governor.try_acquire("issue", "Issues", &label) {
                        Ok(slot) => Some(slot),
                        Err(reason) => {
                            governor.record_deferral("issue", &label, &reason);
                            release_issue_claim(&self.repo_dir, issue.number);
                            self.claiming.remove(&issue.number);
                            deferral = Some(format!(
                                "issue #{} deferred: {}",
                                issue.number,
                                reason.message()
                            ));
                            break;
                        }
                    }
                }
                None => None,
            };
            self.begin(issue, permit).await;
            if self.stopping || self.state.paused || !self.state.enabled {
                break;
            }
        }
        self.state.lifecycle = self.settled_lifecycle();
        self.state.deferral = deferral;
        self.publish();
    }

    /* ------------------------------------------------------------------ */
    /* Runs and peers                                                      */
    /* ------------------------------------------------------------------ */

    fn open_run(&mut self, issue: &Issue) -> Result<WorkerActive, (String, PathBuf, String)> {
        let now = OffsetDateTime::now_utc();
        let base = runs_directory(&self.state_dir, &self.repo_dir);
        let _ = std::fs::create_dir_all(&base);
        let run_id = iso(now).replace([':', '.'], "-");
        let mut created: Option<(PathBuf, String)> = None;
        for attempt in 0..100 {
            let candidate = if attempt == 0 {
                run_id.clone()
            } else {
                format!("{run_id}-{attempt}")
            };
            let directory = base.join(&candidate);
            match std::fs::create_dir(&directory) {
                Ok(()) => {
                    created = Some((directory, candidate));
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => break,
            }
        }
        let Some((directory, run_id)) = created else {
            let detail = format!("could not create a run directory under {}", base.display());
            return Err((run_id, base, detail));
        };
        let activity: Vec<String> = Vec::new();
        let _ = write_activity(&directory, &activity);
        let run = RunFile {
            version: 1,
            run_id: run_id.clone(),
            repo: self.state.repo.clone(),
            status: "running".into(),
            argv: self
                .agent_command
                .split_whitespace()
                .map(str::to_string)
                .collect(),
            cwd: self.repo_dir.display().to_string(),
            started_at: iso(now),
            finished_at: None,
            exit_code: None,
            issues: vec![issue.clone()],
            first_stderr_line: None,
            worker_pid: std::process::id(),
            harness_version: self.harness_version.clone(),
        };
        if let Err(error) = write_run_file(&directory, &run) {
            return Err((run_id, directory, error.to_string()));
        }
        let started_at = run.started_at.clone();
        self.runs.insert(
            0,
            RunEntry {
                run: run.clone(),
                directory: directory.clone(),
            },
        );
        self.prune_history();
        Ok(WorkerActive {
            run_id,
            directory,
            started_at,
            issue: issue.clone(),
            captured: vec![issue.clone()],
            activity,
            peer: None,
            first_line: FirstLine::new(),
            turns: 1,
            settling: false,
            finished: false,
            last_signal: std::time::Instant::now(),
        })
    }

    async fn begin(&mut self, issue: Issue, permit: Option<crate::resources::Slot>) {
        if !self.set_processing(issue.number, true).await {
            if self.claiming.remove(&issue.number) {
                release_issue_claim(&self.repo_dir, issue.number);
            }
            self.state.cooldowns.insert(
                issue.number.to_string(),
                iso_from_millis(epoch_millis(OffsetDateTime::now_utc()) + COOLDOWN_MS as i64),
            );
            self.state.last_error = Some(format!(
                "could not mark issue #{} as processing on the tracker",
                issue.number
            ));
            self.state.lifecycle = self.settled_lifecycle();
            self.publish();
            return;
        }
        if self.stopping {
            self.set_processing(issue.number, false).await;
            if self.claiming.remove(&issue.number) {
                release_issue_claim(&self.repo_dir, issue.number);
            }
            return;
        }
        let mut active = match self.open_run(&issue) {
            Ok(active) => active,
            Err((run_id, directory, error)) => {
                self.set_processing(issue.number, false).await;
                self.fail_without_peer(&issue, &run_id, &directory, &error);
                return;
            }
        };
        if self.stopping {
            if let Some(peer) = &active.peer {
                peer.close();
            }
            self.set_processing(issue.number, false).await;
            if self.claiming.remove(&issue.number) {
                release_issue_claim(&self.repo_dir, issue.number);
            }
            return;
        }
        let environment = match self.peer_environment(&active).await {
            Ok(environment) => environment,
            Err(detail) => {
                self.set_processing(issue.number, false).await;
                self.fail_without_peer(&issue, &active.run_id, &active.directory, &detail);
                return;
            }
        };
        let options = crate::acp::AcpConnectionOptions::new(
            self.agent_command.clone(),
            self.repo_dir.display().to_string(),
        )
        .with_starter("Issues")
        .with_env(environment);
        let options = match permit {
            Some(permit) => options.with_permit(permit),
            None => options,
        };
        let connected = crate::acp::AcpConnection::connect(options).await;
        let (peer, mut receiver) = match connected {
            Ok(value) => value,
            Err(error) => {
                self.set_processing(issue.number, false).await;
                self.fail_without_peer(&issue, &active.run_id, &active.directory, &error.message);
                return;
            }
        };
        let peer = Arc::new(peer);
        active.peer = Some(Arc::clone(&peer));
        let acp_child = peer.pid().map(|pid| AcpChild {
            pid,
            argv: peer.argv(),
            cwd: self.repo_dir.display().to_string(),
        });
        let number = issue.number;
        let events = self.events.clone();
        tokio::spawn(async move {
            while let Some(event) = receiver.recv().await {
                let message = match event {
                    crate::acp::AcpEvent::Activity(entry) => {
                        WorkerEvent::Activity { number, entry }
                    }
                    crate::acp::AcpEvent::Question(question) => {
                        WorkerEvent::Question { number, question }
                    }
                    crate::acp::AcpEvent::Text(_) => continue,
                    crate::acp::AcpEvent::SessionUpdate => WorkerEvent::SessionUpdate { number },
                    crate::acp::AcpEvent::Stderr(text) => WorkerEvent::Stderr { number, text },
                };
                if events.send(message).is_err() {
                    break;
                }
            }
        });
        let run_peer = Arc::clone(&peer);
        let events = self.events.clone();
        let prompt = prompt_for(&issue);
        tokio::spawn(async move {
            let error = run_peer.run(&prompt).await.err().map(|error| {
                if error.message.is_empty() {
                    "the agent ended its turn with an error".to_string()
                } else {
                    error.message
                }
            });
            let _ = events.send(WorkerEvent::TurnEnded { number, error });
        });
        self.active.insert(number, active);
        let agent = Agent {
            run_id: {
                let active = &self.active[&number];
                active.run_id.clone()
            },
            issue_number: number,
            started_at: {
                let active = &self.active[&number];
                active.started_at.clone()
            },
            question: None,
            acp: acp_child,
        };
        self.state.agents.push(agent);
        self.refresh_queue();
        self.state.lifecycle = "running".into();
        self.state.runs = self.summaries();
        self.publish();
    }

    async fn peer_environment(
        &self,
        active: &WorkerActive,
    ) -> Result<HashMap<String, String>, String> {
        let mut environment: HashMap<String, Option<String>> = self
            .environment
            .iter()
            .map(|(key, value)| (key.clone(), Some(value.clone())))
            .collect();
        match crate::providers::worker_peer_environment(
            &self.state_dir,
            &self.repo_dir,
            environment.clone(),
            crate::providers::ProviderOptions::default(),
        )
        .await
        {
            Ok(resolved) => {
                environment = resolved;
            }
            Err(error) => return Err(error.message),
        }
        let mut result: HashMap<String, String> = HashMap::new();
        for (key, value) in environment {
            if let Some(value) = value {
                result.insert(key, value);
            }
        }
        result.insert("DEVBOARD_ISSUES_RUN_ID".into(), active.run_id.clone());
        result.insert(
            "DEVBOARD_ISSUES_ISSUE_NUMBER".into(),
            active.issue.number.to_string(),
        );
        Ok(result)
    }

    fn record_activity(&mut self, number: u64, entry: crate::acp::AcpActivity) {
        let Some(active) = self.active.get_mut(&number) else {
            return;
        };
        if active.finished {
            return;
        }
        active.last_signal = std::time::Instant::now();
        append_activity_line(&mut active.activity, &entry.text, entry.append);
        let _ = write_activity(&active.directory, &active.activity);
        let activity_len = active.activity.len();
        let run_id = active.run_id.clone();
        if let Some(summary) = self.state.runs.iter_mut().find(|run| run.run_id == run_id) {
            summary.activity = activity_len;
        }
        self.publish();
    }

    fn record_question(&mut self, number: u64, question: crate::acp::AcpQuestion) {
        let Some(active) = self.active.get_mut(&number) else {
            return;
        };
        if active.finished {
            return;
        }
        active.last_signal = std::time::Instant::now();
        let run_id = active.run_id.clone();
        let stored = IssuesQuestion {
            id: match &question.id {
                crate::acp::AcpId::Number(value) => json!(value),
                crate::acp::AcpId::String(value) => json!(value),
            },
            message: question.message,
            options: question
                .options
                .into_iter()
                .map(|option| QuestionOption {
                    label: option.label,
                    description: option.description,
                    recommended: option.recommended,
                })
                .collect(),
        };
        for agent in &mut self.state.agents {
            if agent.run_id == run_id {
                agent.question = Some(stored.clone());
            }
        }
        self.publish();
    }

    async fn on_event(&mut self, event: WorkerEvent) {
        match event {
            WorkerEvent::Activity { number, entry } => self.record_activity(number, entry),
            WorkerEvent::Question { number, question } => self.record_question(number, question),
            WorkerEvent::SessionUpdate { number } => {
                if let Some(active) = self.active.get_mut(&number) {
                    active.last_signal = std::time::Instant::now();
                }
            }
            WorkerEvent::Stderr { number, text } => {
                if let Some(active) = self.active.get_mut(&number) {
                    active.first_line.push(&text);
                    active.last_signal = std::time::Instant::now();
                }
            }
            WorkerEvent::TurnEnded { number, error } => match error {
                None => self.finish_turn(number),
                Some(detail) => self.finish_failed(number, detail).await,
            },
            WorkerEvent::FollowUpEnded { number, error } => match error {
                None => self.finish_turn(number),
                Some(detail) => self.finish_failed(number, detail).await,
            },
            WorkerEvent::Verify { number, result } => self.verify_and_settle(number, result).await,
        }
    }

    fn update_run(
        &mut self,
        run_id: &str,
        directory: &Path,
        status: &str,
        finished_at: &str,
        exit_code: Option<i64>,
        first_stderr_line: Option<String>,
    ) {
        let Some(entry) = self
            .runs
            .iter_mut()
            .find(|entry| entry.run.run_id == run_id)
        else {
            return;
        };
        entry.run.status = status.to_string();
        entry.run.finished_at = Some(finished_at.to_string());
        entry.run.exit_code = exit_code;
        entry.run.first_stderr_line = first_stderr_line;
        let _ = write_run_file(directory, &entry.run);
    }

    async fn forget(&mut self, number: u64, run_id: &str) {
        if self.claiming.remove(&number) {
            release_issue_claim(&self.repo_dir, number);
        }
        self.active.remove(&number);
        self.state.agents.retain(|agent| agent.run_id != run_id);
        clear_closed_by_run(&self.state_dir, &self.repo_dir, number, run_id);
        self.set_processing(number, false).await;
    }

    fn settle(&mut self, exit_code: Option<i64>, error: Option<String>, finished_at: String) {
        self.state.runs = self.summaries();
        self.state.last_exit_code = exit_code;
        if let Some(error) = error {
            self.state.last_error = Some(error);
        }
        self.state.finished_at = Some(finished_at);
        let lifecycle = self.settled_lifecycle();
        self.state.lifecycle = lifecycle.clone();
        if lifecycle == "idle" {
            self.state.last_error = None;
            self.state.last_exit_code = None;
            self.state.finished_at = None;
        }
        self.publish();
        if !self.stopping && self.state.enabled && !self.state.paused {
            self.next_poll_due = std::time::Instant::now();
        }
    }

    fn fail_without_peer(&mut self, issue: &Issue, run_id: &str, directory: &Path, detail: &str) {
        if self.claiming.remove(&issue.number) {
            release_issue_claim(&self.repo_dir, issue.number);
        }
        let finished_at = iso_now();
        self.update_run(
            run_id,
            directory,
            "failed",
            &finished_at,
            Some(1),
            Some(detail.to_string()),
        );
        self.state.cooldowns.insert(
            issue.number.to_string(),
            iso_from_millis(epoch_millis(OffsetDateTime::now_utc()) + COOLDOWN_MS as i64),
        );
        self.settle(Some(1), Some(detail.to_string()), finished_at);
    }

    fn finish_turn(&mut self, number: u64) {
        let Some(active) = self.active.get(&number) else {
            return;
        };
        if active.finished || active.settling || self.stopping {
            return;
        }
        if let Some(active) = self.active.get_mut(&number) {
            active.settling = true;
        }
        let events = self.events.clone();
        let issue_number = number;
        let verify = self.issue_state_future(issue_number);
        tokio::spawn(async move {
            let result = verify.await;
            let _ = events.send(WorkerEvent::Verify {
                number: issue_number,
                result,
            });
        });
    }

    /// A one-shot future resolving the issue's tracker state.
    fn issue_state_future(&self, number: u64) -> IssueStateFuture {
        if let Some(read) = &self.issue_state_override {
            return read(number);
        }
        let repo_dir = self.repo_dir.clone();
        let repository = self.state.repo.clone();
        let environment = self.environment.clone();
        Box::pin(
            async move { fetch_issue_state(&repo_dir, &repository, &environment, number).await },
        )
    }

    /// A clean ACP turn is not proof of work; only a closed issue is handled.
    async fn verify_and_settle(&mut self, number: u64, result: IssueStateResult) {
        let Some(active) = self.active.get(&number) else {
            return;
        };
        if active.finished || self.stopping {
            return;
        }
        if let Some(active) = self.active.get_mut(&number) {
            active.settling = false;
        }
        match result {
            IssueStateResult::State { closed: true } => {
                self.close_peer(number);
                self.record_succeeded(number).await;
            }
            IssueStateResult::State { closed: false }
                if self.active[&number].turns <= MAX_FOLLOW_UP_TURNS =>
            {
                self.continue_run(number);
            }
            result => {
                let detail = match result {
                    IssueStateResult::Error { detail } => {
                        format!("could not verify issue #{number}: {detail}")
                    }
                    _ => format!("the agent finished but issue #{number} is still open"),
                };
                if let Some(active) = self.active.get_mut(&number) {
                    active.first_line.finish();
                }
                let detail = match self.active[&number].first_line.value.clone() {
                    Some(stderr) => format!("{detail}; agent stderr: {stderr}"),
                    None => detail,
                };
                self.close_peer(number);
                self.record_failed(number, detail).await;
            }
        }
    }

    fn continue_run(&mut self, number: u64) {
        let Some(active) = self.active.get_mut(&number) else {
            return;
        };
        if active.finished || self.stopping {
            return;
        }
        active.turns += 1;
        active.settling = false;
        active.last_signal = std::time::Instant::now();
        let turns = active.turns;
        let issue = active.issue.clone();
        let Some(peer) = active.peer.clone() else {
            return;
        };
        eprintln!(
            "issues: issue #{} is still open after turn {}; asking the peer to continue",
            number,
            turns - 1
        );
        let events = self.events.clone();
        tokio::spawn(async move {
            let error = peer
                .prompt(&continuation_prompt(&issue, turns, MAX_FOLLOW_UP_TURNS + 1))
                .await
                .err()
                .map(|error| {
                    if error.message.is_empty() {
                        "the agent ended its follow-up turn with an error".to_string()
                    } else {
                        error.message
                    }
                });
            let _ = events.send(WorkerEvent::FollowUpEnded { number, error });
        });
    }

    async fn record_succeeded(&mut self, number: u64) {
        let Some(active) = self.active.get(&number) else {
            return;
        };
        if active.finished || self.stopping {
            return;
        }
        let run_id = active.run_id.clone();
        let directory = active.directory.clone();
        let captured = active.captured.clone();
        if let Some(active) = self.active.get_mut(&number) {
            active.finished = true;
        }
        let finished_at = iso_now();
        self.update_run(
            &run_id,
            &directory,
            "succeeded",
            &finished_at,
            Some(0),
            None,
        );
        self.ledger = record_handled(&self.ledger, &captured, &run_id, &finished_at);
        self.forget(number, &run_id).await;
        self.refresh_queue();
        self.settle(Some(0), None, finished_at);
        if let Err(error) = self.persist_ledger() {
            self.state.last_error = Some(error);
            self.publish();
        }
    }

    async fn record_failed(&mut self, number: u64, detail: String) {
        let Some(active) = self.active.get(&number) else {
            return;
        };
        if active.finished || self.stopping {
            return;
        }
        let run_id = active.run_id.clone();
        let directory = active.directory.clone();
        if let Some(active) = self.active.get_mut(&number) {
            active.finished = true;
        }
        let finished_at = iso_now();
        self.update_run(
            &run_id,
            &directory,
            "failed",
            &finished_at,
            Some(1),
            Some(detail.clone()),
        );
        self.state.cooldowns.insert(
            number.to_string(),
            iso_from_millis(epoch_millis(OffsetDateTime::now_utc()) + COOLDOWN_MS as i64),
        );
        self.forget(number, &run_id).await;
        self.refresh_queue();
        self.settle(Some(1), Some(detail), finished_at);
    }

    async fn finish_failed(&mut self, number: u64, detail: String) {
        let Some(active) = self.active.get(&number) else {
            return;
        };
        if active.finished || active.settling || self.stopping {
            return;
        }
        if let Some(active) = self.active.get_mut(&number) {
            active.settling = true;
        }
        self.close_peer(number);
        if let Some(active) = self.active.get_mut(&number) {
            active.first_line.finish();
        }
        let detail = self.active[&number]
            .first_line
            .value
            .clone()
            .unwrap_or(detail);
        self.record_failed(number, detail).await;
    }

    async fn stop_closed_runs(&mut self, open: &HashSet<u64>) {
        let numbers: Vec<u64> = self.active.keys().copied().collect();
        for number in numbers {
            if open.contains(&number) {
                continue;
            }
            let notice = format!("Issue #{number} was closed on the tracker; its run was stopped.");
            // A goal issue's run records one goal. A poll that dropped it is one
            // observation, so a goal the tracker still lists as open fails with
            // a cooldown instead of ending without a verdict.
            let goal = self
                .active
                .get(&number)
                .map(|active| is_goal_issue(&active.issue))
                .unwrap_or(false);
            if goal {
                self.settle_dropped_goal(number, notice).await;
            } else {
                self.abandon_run(number, notice).await;
            }
        }
    }

    /// Settles a goal-issue run the poll no longer lists. A close the tracker
    /// proves is the operator's cancellation and keeps the `stopped` record; an
    /// issue still open at the tracker fails the run with a detail naming it.
    async fn settle_dropped_goal(&mut self, number: u64, notice: String) {
        let Some(active) = self.active.get(&number) else {
            return;
        };
        if active.finished || active.settling {
            return;
        }
        if closed_by_run(&self.state_dir, &self.repo_dir, number).as_deref()
            == Some(active.run_id.as_str())
        {
            return;
        }
        if let Some(active) = self.active.get_mut(&number) {
            active.settling = true;
        }
        let result = self.issue_state_future(number).await;
        if self.stopping {
            return;
        }
        let Some(active) = self.active.get(&number) else {
            return;
        };
        if active.finished {
            return;
        }
        match result {
            IssueStateResult::State { closed: true } => {
                if let Some(active) = self.active.get_mut(&number) {
                    active.settling = false;
                }
                self.abandon_run(number, notice).await;
            }
            result => {
                self.close_peer(number);
                if let Some(active) = self.active.get_mut(&number) {
                    active.first_line.finish();
                }
                let detail = match result {
                    IssueStateResult::Error { detail } => {
                        format!("could not verify issue #{number}: {detail}")
                    }
                    _ => format!(
                        "the tracker dropped issue #{number} from its open list while it is still open"
                    ),
                };
                let detail = self.active[&number]
                    .first_line
                    .value
                    .clone()
                    .map(|stderr| format!("{detail}; agent stderr: {stderr}"))
                    .unwrap_or(detail);
                self.record_failed(number, detail).await;
            }
        }
    }

    async fn reclaim_silent_runs(&mut self) {
        if self.stopping || self.active.is_empty() {
            return;
        }
        let now = std::time::Instant::now();
        let numbers: Vec<u64> = self.active.keys().copied().collect();
        for number in numbers {
            let Some(active) = self.active.get(&number) else {
                continue;
            };
            if active.finished || active.settling {
                continue;
            }
            let silent_for = now.duration_since(active.last_signal).as_millis() as u64;
            if silent_for < TURN_SILENCE_MS {
                continue;
            }
            self.fail_silent_run(number, silent_for).await;
        }
    }

    async fn fail_silent_run(&mut self, number: u64, silent_for: u64) {
        let Some(active) = self.active.get(&number) else {
            return;
        };
        if active.finished || active.settling || self.stopping {
            return;
        }
        if let Some(active) = self.active.get_mut(&number) {
            active.settling = true;
        }
        let result = self.issue_state_future(number).await;
        if self.stopping {
            return;
        }
        match result {
            IssueStateResult::State { closed: true } => {
                self.close_peer(number);
                self.record_succeeded(number).await;
            }
            result => {
                let minutes = (silent_for / 60_000).max(1);
                if let Some(active) = self.active.get_mut(&number) {
                    active.first_line.finish();
                }
                self.close_peer(number);
                let detail = match result {
                    IssueStateResult::Error { detail } => format!(
                        "the agent produced no output for {minutes} minute(s) and issue #{number} could not be verified: {detail}"
                    ),
                    _ => format!(
                        "the agent produced no output for {minutes} minute(s); issue #{number} is still open"
                    ),
                };
                let detail = self.active[&number]
                    .first_line
                    .value
                    .clone()
                    .map(|stderr| format!("{detail}; agent stderr: {stderr}"))
                    .unwrap_or(detail);
                self.record_failed(number, detail).await;
            }
        }
    }

    async fn abandon_run(&mut self, number: u64, notice: String) {
        let Some(active) = self.active.get(&number) else {
            return;
        };
        if active.finished || active.settling {
            return;
        }
        if closed_by_run(&self.state_dir, &self.repo_dir, number).as_deref()
            == Some(active.run_id.as_str())
        {
            return;
        }
        let now = std::time::Instant::now();
        self.dismissed
            .insert(number, now + Duration::from_millis(DISMISS_MS));
        let run_id = active.run_id.clone();
        let directory = active.directory.clone();
        if let Some(active) = self.active.get_mut(&number) {
            active.finished = true;
        }
        self.close_peer(number);
        let finished_at = iso_now();
        self.update_run(&run_id, &directory, "stopped", &finished_at, None, None);
        self.forget(number, &run_id).await;
        self.refresh_queue();
        self.state.notice = Some(notice);
        self.settle(None, None, finished_at);
    }

    fn close_peer(&mut self, number: u64) {
        if let Some(active) = self.active.get(&number) {
            if let Some(peer) = &active.peer {
                peer.close();
            }
        }
    }

    fn prune_history(&mut self) {
        let mut kept: HashSet<String> = HashSet::new();
        let mut finished = 0;
        for entry in &self.runs {
            if entry.run.status == "running" {
                kept.insert(entry.directory.display().to_string());
                continue;
            }
            if finished < RUN_HISTORY_LIMIT {
                kept.insert(entry.directory.display().to_string());
                finished += 1;
            }
        }
        for entry in &self.runs {
            if kept.contains(&entry.directory.display().to_string()) {
                continue;
            }
            let _ = std::fs::remove_dir_all(&entry.directory);
        }
        self.runs
            .retain(|entry| kept.contains(&entry.directory.display().to_string()));
    }

    /// Stop: end every peer, record `stopped`, leave captured issues unhandled.
    async fn stop(&mut self) {
        if self.stopping {
            return;
        }
        self.stopping = true;
        self.state.enabled = false;
        self.state.paused = false;
        self.state.cooldowns.clear();
        let numbers: Vec<u64> = self.active.keys().copied().collect();
        for number in &numbers {
            let Some(active) = self.active.get_mut(number) else {
                continue;
            };
            if active.finished {
                continue;
            }
            active.finished = true;
            if let Some(peer) = &active.peer {
                peer.close();
            }
            let finished_at = iso_now();
            let run_id = active.run_id.clone();
            let directory = active.directory.clone();
            self.update_run(&run_id, &directory, "stopped", &finished_at, None, None);
        }
        for number in numbers.clone() {
            self.close_peer(number);
        }
        for number in &numbers {
            self.set_processing(*number, false).await;
        }
        self.active.clear();
        for number in self.claiming.clone() {
            release_issue_claim(&self.repo_dir, number);
        }
        self.claiming.clear();
        self.state.agents.clear();
        for issue in &mut self.state.queue {
            issue.agent_run_id = None;
        }
        self.state.runs = self.summaries();
        self.state.last_exit_code = None;
        self.state.last_error = None;
        self.state.lifecycle = "stopped".into();
        self.state.notice = None;
        self.state.deferral = None;
        self.publish();
        if let Some((path, token)) = self.lock.take() {
            release_lock(&path, &token);
        }
        eprintln!("issues: stopped");
    }
}

fn prompt_for(issue: &Issue) -> String {
    let command = if issue.labels.iter().any(|label| label == GOAL_LABEL) {
        IMPLEMENT_GOAL_COMMAND
    } else {
        IMPLEMENT_ISSUE_COMMAND
    };
    format!("{command} {}", issue.number)
}

fn continuation_prompt(issue: &Issue, turn: u32, limit: u32) -> String {
    [
        format!(
            "Continue issue #{} in this session. Your previous turn ended while the issue was still open.",
            issue.number
        ),
        "Nothing prompts this session again, so ending a turn before the issue is closed leaves it unhandled."
            .to_string(),
        "If you started a background job, wait for it (`wait`) and read its result before you finish."
            .to_string(),
        "Do not repeat work that already landed: check the pushed revision and the issue state first."
            .to_string(),
        format!("Finish the task and close the issue, or stop with the one concrete blocker. Follow-up turn {turn} of {limit}."),
    ]
    .join(" ")
}

fn load_runs(state_dir: &Path, repo_dir: &Path) -> Vec<(RunFile, PathBuf, usize)> {
    let mut found = Vec::new();
    let mut finished = 0;
    for name in list_run_directories(state_dir, repo_dir) {
        let directory = runs_directory(state_dir, repo_dir).join(&name);
        let Ok(text) = std::fs::read_to_string(run_file_path(&directory)) else {
            continue;
        };
        let Some(run) = parse_run_file(&text) else {
            continue;
        };
        let activity = read_activity(&directory).len();
        if run.status == "running" {
            found.push((run, directory, activity));
        } else if finished < RUN_HISTORY_LIMIT {
            found.push((run, directory, activity));
            finished += 1;
        }
    }
    found
}

/* ------------------------------------------------------------------------ */
/* Worker tracker helpers                                                    */
/* ------------------------------------------------------------------------ */

type IssueStateFuture = Pin<Box<dyn Future<Output = IssueStateResult> + Send>>;

fn tracker_options(
    repo_dir: &Path,
    repository: &str,
    environment: &HashMap<String, String>,
) -> crate::forge::TrackerOptions {
    let remote = crate::forge::origin_forge_with(repo_dir, environment);
    let forge = remote
        .as_ref()
        .map(|remote| remote.forge)
        .unwrap_or(crate::forge::Forge::GitHub);
    let base_url = crate::forge::gitea_base_url(remote.as_ref(), environment);
    crate::forge::TrackerOptions {
        forge,
        repository: repository.to_string(),
        etag: None,
        run: None,
        environment: environment.clone(),
        timeout_ms: Some(TRACKER_TIMEOUT_MS),
        base_url,
        transport: None,
    }
}

/// The tracker's current state for one issue.
async fn fetch_issue_state(
    repo_dir: &Path,
    repository: &str,
    environment: &HashMap<String, String>,
    number: u64,
) -> IssueStateResult {
    let options = tracker_options(repo_dir, repository, environment);
    match crate::forge::fetch_issue_state(&options, number as i64).await {
        crate::forge::IssueStateResult::State(state) => IssueStateResult::State {
            closed: state == crate::forge::IssueState::Closed,
        },
        crate::forge::IssueStateResult::Error { detail } => IssueStateResult::Error { detail },
    }
}

/// Writes or clears the one `processing` label on one issue.
async fn write_processing(
    repo_dir: &Path,
    repository: &str,
    environment: &HashMap<String, String>,
    number: u64,
    active: bool,
) -> Result<(), String> {
    let options = tracker_options(repo_dir, repository, environment);
    match crate::forge::write_issue_processing(&options, number as i64, active).await {
        crate::forge::ProcessingWriteResult::Ok => Ok(()),
        crate::forge::ProcessingWriteResult::Error { detail } => Err(detail),
    }
}

/// A child recorded by a previous worker, as the process table sees it.
fn recorded_child_alive(child: &AcpChild) -> bool {
    if !pid_alive(child.pid) {
        return false;
    }
    let Ok(text) = std::fs::read_to_string(format!("/proc/{}/cmdline", child.pid)) else {
        return false;
    };
    let argv: Vec<String> = text
        .split('\u{0}')
        .filter(|entry| !entry.is_empty())
        .map(str::to_string)
        .collect();
    argv == child.argv
}

fn previous_records(text: Option<&str>) -> (Vec<AcpChild>, Vec<String>) {
    let Some(text) = text else {
        return (Vec::new(), Vec::new());
    };
    let Ok(parsed) = serde_json::from_str::<Value>(text) else {
        return (Vec::new(), Vec::new());
    };
    let Some(record) = parsed.as_object() else {
        return (Vec::new(), Vec::new());
    };
    let mut children = Vec::new();
    let mut run_ids = Vec::new();
    let collect = |value: &Value, children: &mut Vec<AcpChild>| {
        if let Ok(child) = serde_json::from_value::<AcpChild>(value.clone()) {
            if is_acp_child(value) {
                children.push(child);
            }
        }
    };
    if let Some(agents) = record.get("agents").and_then(Value::as_array) {
        for agent in agents {
            if let Some(run_id) = agent.get("runId").and_then(Value::as_str) {
                run_ids.push(run_id.to_string());
            }
            if let Some(acp) = agent.get("acp") {
                collect(acp, &mut children);
            }
        }
    }
    if let Some(acp) = record.get("acp") {
        collect(acp, &mut children);
    }
    if let Some(active) = record.get("activeRun") {
        if let Some(run_id) = active.get("runId").and_then(Value::as_str) {
            run_ids.push(run_id.to_string());
        }
    }
    (children, run_ids)
}

/* ------------------------------------------------------------------------ */
/* Worker entry                                                              */
/* ------------------------------------------------------------------------ */

fn worker_arguments(args: &[String]) -> Option<(PathBuf, PathBuf, Option<u64>)> {
    let mut repo_dir: Option<PathBuf> = None;
    let mut state_dir: Option<PathBuf> = None;
    let mut interval: Option<u64> = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "worker" | "issues" => {
                index += 1;
                continue;
            }
            "--repo" | "--state-dir" | "--interval" => {
                let value = args.get(index + 1)?;
                index += 2;
                match args[index - 2].as_str() {
                    "--repo" => repo_dir = Some(absolute(Path::new(value))),
                    "--state-dir" => state_dir = Some(absolute(Path::new(value))),
                    _ => {
                        let parsed: u64 = value.parse().ok()?;
                        if parsed > 0 {
                            interval = Some(parsed);
                        }
                    }
                }
            }
            other => {
                eprintln!("issues worker: unexpected argument {other}");
                return None;
            }
        }
    }
    Some((repo_dir?, state_dir?, interval))
}

/// Runs the detached Issues worker for exactly one repository.
pub async fn run_worker(args: &[String]) -> anyhow::Result<()> {
    let Some((repo_dir, state_dir, interval)) = worker_arguments(args) else {
        anyhow::bail!(
            "usage: devboard worker issues --repo <checkout> --state-dir <dir> [--interval <ms>]"
        );
    };
    let environment = crate::forge::process_environment();
    let repository = crate::forge::origin_repository_with(&repo_dir, &environment);
    let Some(repository) = repository else {
        anyhow::bail!("issues worker: the checkout's origin does not name a repository");
    };
    let version = std::env::var("DEVBOARD_HARNESS_VERSION")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| crate::version::read_harness_version(&crate::version::running_harness_dir()));
    if let Some(legacy) = live_lock_owner(&lock_path(&repo_dir)) {
        if legacy.harness_version.is_none() || legacy.harness_version == version {
            eprintln!("issues worker: this checkout already has a live worker for this version");
            return Ok(());
        }
    }
    if live_lock_owner(&versioned_lock_path(&repo_dir, version.as_deref())).is_some() {
        eprintln!("issues worker: this checkout already has a live worker for this version");
        return Ok(());
    }
    let agent_command = std::env::var("AGENT_COMMAND")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_AGENT_COMMAND.to_string());
    let mut worker = IssuesWorker::new(
        repo_dir,
        state_dir,
        interval.unwrap_or(DEFAULT_INTERVAL_MS),
        agent_command,
        environment,
        version,
    );
    if !worker.start(&repository) {
        return Ok(());
    }
    let mut ticker = tokio::time::interval(Duration::from_millis(WORKER_TICK_MS));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    #[cfg(unix)]
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    loop {
        #[cfg(unix)]
        let signalled = tokio::select! {
            _ = ticker.tick() => None,
            Some(event) = worker.receptor.recv() => {
                worker.on_event(event).await;
                None
            }
            _ = terminate.recv() => Some("SIGTERM"),
            _ = interrupt.recv() => Some("SIGINT"),
        };
        #[cfg(not(unix))]
        let signalled: Option<&str> = tokio::select! {
            _ = ticker.tick() => { worker.tick().await; None }
            Some(event) = worker.receptor.recv() => { worker.on_event(event).await; None }
        };
        #[cfg(unix)]
        {
            match signalled {
                Some(signal) => {
                    eprintln!("issues: received {signal}");
                    worker.stop().await;
                    return Ok(());
                }
                None => worker.tick().await,
            }
        }
        if worker.stopping {
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit_root(label: &str) -> (PathBuf, PathBuf) {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!("issues-unit-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let repo = root.join("repo");
        let state = root.join("state");
        std::fs::create_dir_all(repo.join(".devboard").join(".tmp")).expect("a repo");
        std::fs::create_dir_all(&state).expect("a state directory");
        (repo, state)
    }

    fn issue(number: u64, labels: &[&str]) -> Issue {
        Issue {
            number,
            title: format!("Issue {number}"),
            url: format!("https://example.test/issues/{number}"),
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            labels: labels.iter().map(|label| label.to_string()).collect(),
            body: None,
        }
    }

    fn worker(repo: &Path, state: &Path) -> IssuesWorker {
        let mut worker = IssuesWorker::new(
            repo.to_path_buf(),
            state.to_path_buf(),
            100,
            "omp acp".to_string(),
            HashMap::new(),
            Some("1.2.3".to_string()),
        );
        worker.state.repo = "acme/app".to_string();
        worker.state.enabled = true;
        worker.processing_override = Some(Arc::new(|_, _| Box::pin(async { Ok(()) })));
        worker
    }

    fn attach(worker: &mut IssuesWorker, issue: Issue) {
        let active = worker.open_run(&issue).expect("a run");
        worker.state.queue = vec![worker.queued(&issue)];
        worker.active.insert(issue.number, active);
    }

    fn entry(number: u64, run_id: &str) -> HandledIssue {
        HandledIssue {
            number,
            run_id: run_id.to_string(),
            at: "2026-01-01T00:00:00.000Z".to_string(),
        }
    }

    struct NoProcProbe {
        alive: bool,
    }

    impl LockProbe for NoProcProbe {
        fn pid_alive(&self, _pid: u32) -> bool {
            self.alive
        }

        fn process_started_at(&self, _pid: u32) -> Option<i64> {
            None
        }

        fn reports_process_start(&self) -> bool {
            false
        }
    }

    fn owner() -> LockOwner {
        LockOwner {
            pid: 4242,
            started_at: "2026-01-01T00:00:00.000Z".to_string(),
            repo: "repo".to_string(),
            state_dir: "state".to_string(),
            harness_version: None,
            argv: Vec::new(),
        }
    }

    #[test]
    fn a_live_owner_on_a_platform_without_proc_is_live() {
        assert!(owner_alive_with(&owner(), &NoProcProbe { alive: true }));
        assert!(!owner_alive_with(&owner(), &NoProcProbe { alive: false }));
    }

    #[test]
    fn a_lock_whose_owner_is_gone_is_reclaimed() {
        let (repo, state) = unit_root("lock-reclaim");
        let path = versioned_lock_path(&repo, None);
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("a lock directory");
        let dead = LockOwner {
            pid: 999_999,
            started_at: iso_now(),
            repo: repo.display().to_string(),
            state_dir: state.display().to_string(),
            harness_version: None,
            argv: Vec::new(),
        };
        std::fs::write(&path, crate::jsjson::stringify(&dead.to_json())).expect("a stale lock");
        let acquired = acquire_lock(
            &path,
            (
                &repo,
                &state,
                None,
                vec!["devboard".to_string(), "worker".to_string()],
            ),
        );
        assert!(acquired.is_ok(), "the stale lock was not reclaimed");
        let owner = read_lock(&path).expect("the new lock");
        assert_eq!(owner.pid, std::process::id());
    }

    #[test]
    fn a_truncated_multibyte_line_never_panics() {
        let mut line = FirstLine::new();
        // Each U+2003 is three bytes and whitespace, so no line is found and
        // the 400-byte tail cut lands inside a character.
        let text = "\u{2003}".repeat(1067);
        assert_eq!(text.len(), 3201);
        line.push(&text);
        assert!(!line.found);
        assert!(line.buffer.is_char_boundary(0));
        line.finish();
        assert!(line.value.is_none());
    }

    #[test]
    fn a_ledger_write_merges_another_versions_entries() {
        let (repo, state) = unit_root("ledger-merge");
        let mut worker = worker(&repo, &state);
        write_ledger(
            &state,
            &repo,
            &Ledger {
                version: LEDGER_VERSION,
                handled: BTreeMap::from([("1".to_string(), entry(1, "run-a"))]),
            },
        )
        .expect("version A's ledger");
        worker.state.queue = vec![
            QueuedIssue::from_issue(&issue(1, &[]), None, None),
            QueuedIssue::from_issue(&issue(2, &[]), None, None),
        ];
        worker.ledger = Ledger {
            version: LEDGER_VERSION,
            handled: BTreeMap::from([("2".to_string(), entry(2, "run-b"))]),
        };
        worker.persist_ledger().expect("the merged ledger");
        let read = load_ledger(&state, &repo);
        let mut numbers: Vec<u64> = read.handled.values().map(|entry| entry.number).collect();
        numbers.sort();
        assert_eq!(numbers, vec![1, 2]);
    }

    #[test]
    fn a_pruned_entry_is_not_resurrected_by_another_worker() {
        let (repo, state) = unit_root("ledger-pruned");
        let mut worker = worker(&repo, &state);
        write_ledger(
            &state,
            &repo,
            &Ledger {
                version: LEDGER_VERSION,
                handled: BTreeMap::from([
                    ("1".to_string(), entry(1, "run-a")),
                    ("3".to_string(), entry(3, "run-c")),
                ]),
            },
        )
        .expect("the shared ledger");
        worker.state.queue = vec![QueuedIssue::from_issue(&issue(1, &[]), None, None)];
        worker.pruned.insert(3);
        worker.persist_ledger().expect("the ledger");
        let read = load_ledger(&state, &repo);
        assert!(read.handled.contains_key("1"));
        assert!(!read.handled.contains_key("3"));
    }

    #[test]
    fn a_legacy_ledger_is_imported_once_for_matching_root() {
        let (repo, state) = unit_root("legacy-ledger");
        let legacy = state.join("orchestrator");
        std::fs::create_dir_all(&legacy).expect("legacy state");
        std::fs::write(
            legacy.join("state.json"),
            json!({"root": repo.display().to_string()}).to_string(),
        )
        .expect("legacy state");
        std::fs::write(
            legacy.join("ledger.json"),
            json!({
                "version": 1,
                "handled": {
                    "7": {"number": 7, "runId": "legacy-run", "at": ""}
                }
            })
            .to_string(),
        )
        .expect("legacy ledger");
        let migrated = migrate_legacy_ledger(&state, &repo, "2026-02-02T00:00:00.000Z")
            .expect("the migrated entries");
        assert_eq!(migrated.len(), 1);
        assert_eq!(migrated[0].number, 7);
        assert_eq!(migrated[0].run_id, "legacy-run");
        assert_eq!(migrated[0].at, "2026-02-02T00:00:00.000Z");
        // The worker's startup write is what makes the import one-time.
        let mut imported = Ledger::empty();
        for entry in migrated {
            imported.handled.insert(entry.number.to_string(), entry);
        }
        write_ledger(&state, &repo, &imported).expect("the target ledger");
        assert!(migrate_legacy_ledger(&state, &repo, "2026-02-02T00:00:00.000Z").is_none());
        assert!(load_ledger(&state, &repo).handled.contains_key("7"));
    }

    #[test]
    fn a_legacy_ledger_from_another_root_is_ignored() {
        let (repo, state) = unit_root("legacy-mismatch");
        let legacy = state.join("orchestrator");
        std::fs::create_dir_all(&legacy).expect("legacy state");
        std::fs::write(
            legacy.join("state.json"),
            json!({"root": "/somewhere/else"}).to_string(),
        )
        .expect("legacy state");
        std::fs::write(
            legacy.join("ledger.json"),
            json!({"version": 1, "handled": {"7": {"number": 7, "runId": "r", "at": "x"}}})
                .to_string(),
        )
        .expect("legacy ledger");
        assert!(migrate_legacy_ledger(&state, &repo, "2026-02-02T00:00:00.000Z").is_none());
    }

    #[tokio::test]
    async fn a_dropped_open_goal_issue_fails_with_a_cooldown() {
        let (repo, state) = unit_root("dropped-open");
        let mut worker = worker(&repo, &state);
        attach(&mut worker, issue(5, &[GOAL_LABEL]));
        worker.issue_state_override = Some(Arc::new(|_| {
            Box::pin(async { IssueStateResult::State { closed: false } })
        }));
        worker.apply_issues(vec![issue(99, &[])]).await;
        assert!(worker.active.is_empty());
        assert!(worker.state.cooldowns.contains_key("5"));
        assert!(worker
            .state
            .last_error
            .as_deref()
            .unwrap_or("")
            .contains("the tracker dropped issue #5 from its open list while it is still open"));
        let run = worker.runs.first().expect("the run");
        assert_eq!(run.run.status, "failed");
    }

    #[tokio::test]
    async fn a_dropped_closed_goal_issue_settles_without_a_failure() {
        let (repo, state) = unit_root("dropped-closed");
        let mut worker = worker(&repo, &state);
        attach(&mut worker, issue(6, &[GOAL_LABEL]));
        worker.issue_state_override = Some(Arc::new(|_| {
            Box::pin(async { IssueStateResult::State { closed: true } })
        }));
        worker.apply_issues(Vec::new()).await;
        assert!(worker.active.is_empty());
        assert!(!worker.state.cooldowns.contains_key("6"));
        assert_eq!(worker.state.last_exit_code, None);
        assert!(worker.dismissed.contains_key(&6));
        let run = worker.runs.first().expect("the run");
        assert_eq!(run.run.status, "stopped");
    }

    #[tokio::test]
    async fn abandon_refuses_a_run_that_closed_its_own_issue() {
        let (repo, state) = unit_root("abandon-self-closed");
        let mut worker = worker(&repo, &state);
        attach(&mut worker, issue(8, &[GOAL_LABEL]));
        let run_id = worker.active[&8].run_id.clone();
        record_closed_by_run(&state, &repo, 8, &run_id);
        worker.apply(IssuesCommand::Abandon { number: 8 }).await;
        assert!(worker.active.contains_key(&8));
        assert!(!worker.dismissed.contains_key(&8));
    }

    #[tokio::test]
    async fn abandon_verifies_a_goal_issue_before_settling() {
        let (repo, state) = unit_root("abandon-goal");
        let mut worker = worker(&repo, &state);
        attach(&mut worker, issue(9, &[GOAL_LABEL]));
        worker.issue_state_override = Some(Arc::new(|_| {
            Box::pin(async { IssueStateResult::State { closed: true } })
        }));
        worker.apply(IssuesCommand::Abandon { number: 9 }).await;
        assert!(worker.active.is_empty());
        assert!(worker.dismissed.contains_key(&9));
        let run = worker.runs.first().expect("the run");
        assert_eq!(run.run.status, "stopped");
    }

    #[tokio::test]
    async fn a_dismissed_issue_is_not_queued_again() {
        let (repo, state) = unit_root("abandon-dismissed");
        let mut worker = worker(&repo, &state);
        attach(&mut worker, issue(10, &[]));
        worker.issue_state_override = Some(Arc::new(|_| {
            Box::pin(async { IssueStateResult::State { closed: true } })
        }));
        worker.apply(IssuesCommand::Abandon { number: 10 }).await;
        assert!(worker.dismissed.contains_key(&10));
        let until = worker.dismissed[&10];
        assert!(until > std::time::Instant::now());
    }

    struct FlatMemory {
        total_mb: u64,
        available_mb: u64,
    }

    impl crate::resources::MemoryReader for FlatMemory {
        fn total_mb(&self) -> u64 {
            self.total_mb
        }

        fn available_mb(&self) -> Option<u64> {
            Some(self.available_mb)
        }

        fn cpu_count(&self) -> u32 {
            8
        }
    }

    #[tokio::test]
    async fn the_deferral_names_every_live_starter() {
        let (repo, state) = unit_root("deferral-starters");
        let governor = crate::resources::Governor::new(
            &state.join("governor"),
            crate::resources::GovernorOptions::in_memory(
                Arc::new(FlatMemory {
                    total_mb: 65_536,
                    available_mb: 60_000,
                }),
                BTreeMap::from([("DEVBOARD_MAX_AGENT_PEERS".to_string(), "2".to_string())]),
            ),
        );
        let watchdog = governor
            .try_acquire("watchdog", "Watchdog", "run 1")
            .expect("the first slot");
        let scout = governor
            .try_acquire("scout", "Auto Scout", "run 2")
            .expect("the second slot");
        assert_eq!(watchdog.starter(), "Watchdog");
        assert_eq!(scout.starter(), "Auto Scout");

        let mut worker = worker(&repo, &state);
        worker.agent_command = "/bin/false".to_string();
        worker.governor_override = Some(governor);
        let queued = issue(7, &[]);
        worker.state.queue = vec![worker.queued(&queued)];

        worker.maybe_trigger().await;
        let expected = "issue #7 deferred: 2 agent peer(s) already run at the cap of 2 \
                        (Auto Scout 1, Watchdog 1); the start is deferred";
        assert_eq!(worker.state.deferral.as_deref(), Some(expected));
        let published =
            read_state(&versioned_state_path(&state, &repo, Some("1.2.3"))).expect("the state");
        assert_eq!(published.deferral.as_deref(), Some(expected));

        // One slot frees; the next pass admits the queued issue and drops the
        // line without a worker restart.
        drop(scout);
        worker.maybe_trigger().await;
        assert_eq!(worker.state.deferral, None);
        let published =
            read_state(&versioned_state_path(&state, &repo, Some("1.2.3"))).expect("the state");
        assert_eq!(published.deferral, None);
    }

    #[tokio::test]
    async fn a_resolved_deferral_leaves_no_line_behind() {
        let (repo, state) = unit_root("deferral-resolved");
        let mut worker = worker(&repo, &state);
        worker.state.deferral = Some(
            "issue #7 deferred: 12 agent peer(s) already run at the cap of 12 (Issues 12); \
             the start is deferred"
                .to_string(),
        );
        // This pass starts nothing: the queue is empty and this process holds
        // no governor, so no deferral is in force when it ends.
        worker.maybe_trigger().await;
        assert_eq!(worker.state.deferral, None);
        let published =
            read_state(&versioned_state_path(&state, &repo, Some("1.2.3"))).expect("the state");
        assert_eq!(published.deferral, None);
    }
}

// __ISSUES_MODE_NEXT__
