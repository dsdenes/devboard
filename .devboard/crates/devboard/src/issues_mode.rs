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

/// True when the worker's last read listed this issue with the goal label.
fn state_issue_is_goal(state: &IssuesState, number: u64) -> bool {
    state
        .queue
        .iter()
        .find(|issue| issue.number == number)
        .map(|issue| issue.labels.iter().any(|label| label == GOAL_LABEL))
        .unwrap_or(false)
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
/// The dashboard's own Issues snapshot cadence. The page refreshes every
/// registered resource once a second, so one build per second serves it: the
/// bridge no longer rebuilds a history-sized projection four times a second
/// whether or not anything changed.
const DASHBOARD_POLL_MS: u64 = 1_000;
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
const WORKER_TICK_MS: u64 = 250;
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
    issues_root(state_dir).join(crate::journal::repo_key(repo_dir))
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

fn operator_closed_directory(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    repo_state_directory(state_dir, repo_dir).join("operator-closed")
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

/// One epoch instant in milliseconds.
fn wall_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// The instant a live process started, from the shared liveness read.
fn process_started_at(pid: u32) -> Option<i64> {
    crate::supervision::process_age_ms(pid).map(|age| wall_millis() - age as i64)
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
    crate::sampling::text(path).and_then(|text| parse_lock(&text))
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct IssueClaim {
    number: u64,
    pid: u32,
    /// The owner's kernel start tick. Absent on a legacy claim, whose owner is
    /// proven only by a live worker lock naming the same pid and version.
    start_ticks: Option<i64>,
    harness_version: Option<String>,
    /// The run that owns the issue: the id its directory and `run.json` carry.
    run_id: String,
}

/// One proven live owner of a queued claim.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ClaimHolder {
    pid: u32,
    version: Option<String>,
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
    if run_id.is_empty()
        || run_id == "."
        || run_id == ".."
        || run_id.contains('/')
        || run_id.contains('\\')
    {
        return None;
    }
    let start_ticks = match object.get("startTicks") {
        None | Some(Value::Null) => None,
        Some(value) => Some(value.as_i64()?),
    };
    let harness_version = match object.get("harnessVersion") {
        None | Some(Value::Null) => None,
        Some(value) => Some(value.as_str()?.to_string()),
    };
    Some(IssueClaim {
        number,
        pid: pid as u32,
        start_ticks,
        harness_version,
        run_id: run_id.to_string(),
    })
}

fn read_issue_claim(repo_dir: &Path, number: u64) -> Option<IssueClaim> {
    std::fs::read_to_string(claim_path(repo_dir, number))
        .ok()
        .and_then(|text| parse_claim(&text))
}

/// The run record a claim names, when that record parses.
fn claimed_run(state_dir: &Path, repo_dir: &Path, run_id: &str) -> Option<RunFile> {
    let path = run_file_path(&run_directory(state_dir, repo_dir, run_id));
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| parse_run_file(&text))
}

fn claimed_run_is_running(state_dir: &Path, repo_dir: &Path, run_id: &str) -> bool {
    claimed_run(state_dir, repo_dir, run_id)
        .map(|run| run.status == "running")
        .unwrap_or(false)
}

/// The live worker lock that proves a legacy claim: the recorded pid and
/// harness version must be the claim's.
fn legacy_claim_lock(repo_dir: &Path, claim: &IssueClaim) -> Option<LockOwner> {
    live_lock_owners(&lock_path(repo_dir))
        .into_iter()
        .find(|owner| owner.pid == claim.pid && owner.harness_version == claim.harness_version)
}

/// The one rule that decides whether a claim still proves its owner. An
/// identity claim is live only while the exact process it names still runs and
/// the run it names is still `running`; a legacy claim without a start tick is
/// live only while a worker lock names the same pid and version.
fn claim_is_live(state_dir: &Path, repo_dir: &Path, claim: &IssueClaim) -> bool {
    match claim.start_ticks {
        Some(start_ticks) => {
            crate::supervision::live_identity(claim.pid, Some(start_ticks))
                && claimed_run_is_running(state_dir, repo_dir, &claim.run_id)
        }
        None => legacy_claim_lock(repo_dir, claim).is_some(),
    }
}

/// The holder a live claim proves, with the harness version its own worker
/// state records: the run record for an identity claim, the lock for a legacy
/// one. `None` when the claim is not live.
fn live_claim_holder(state_dir: &Path, repo_dir: &Path, claim: &IssueClaim) -> Option<ClaimHolder> {
    if !claim_is_live(state_dir, repo_dir, claim) {
        return None;
    }
    let version = if claim.start_ticks.is_some() {
        claimed_run(state_dir, repo_dir, &claim.run_id).and_then(|run| run.harness_version)
    } else {
        legacy_claim_lock(repo_dir, claim).and_then(|owner| owner.harness_version)
    };
    Some(ClaimHolder {
        pid: claim.pid,
        version: version.or_else(|| claim.harness_version.clone()),
    })
}

/// Counts one queued issue under its proven holder, when the claim still
/// proves one. A claim that proves no holder contributes no line.
fn count_claim_holder(
    held: &mut BTreeMap<u32, (Option<String>, usize)>,
    state_dir: &Path,
    repo_dir: &Path,
    number: u64,
) {
    let Some(claim) = read_issue_claim(repo_dir, number) else {
        return;
    };
    let Some(holder) = live_claim_holder(state_dir, repo_dir, &claim) else {
        return;
    };
    match held.entry(holder.pid) {
        std::collections::btree_map::Entry::Occupied(mut entry) => {
            let entry = entry.get_mut();
            entry.1 += 1;
            if entry.0.is_none() {
                entry.0 = holder.version;
            }
        }
        std::collections::btree_map::Entry::Vacant(entry) => {
            entry.insert((holder.version, 1));
        }
    }
}

fn live_issue_claims(state_dir: &Path, repo_dir: &Path) -> Vec<IssueClaim> {
    let mut claims = Vec::new();
    let Ok(entries) = std::fs::read_dir(claims_directory(repo_dir)) else {
        return claims;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        // A record that does not parse proves no owner and blocks nothing;
        // leaving it avoids deleting a claim another version is still writing.
        let Some(claim) = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| parse_claim(&text))
        else {
            continue;
        };
        if !claim_is_live(state_dir, repo_dir, &claim) {
            let _ = std::fs::remove_file(&path);
            continue;
        }
        claims.push(claim);
    }
    claims
}

/// The issue numbers this checkout's live claims own.
fn claimed_issue_numbers(state_dir: &Path, repo_dir: &Path) -> HashSet<u64> {
    live_issue_claims(state_dir, repo_dir)
        .into_iter()
        .map(|claim| claim.number)
        .collect()
}

/// The open issues that carry the `processing` label with no owner in
/// `owned`: the labels a stopped, killed, or upgraded-away run left behind.
fn unclaimed_processing(issues: &[Issue], owned: &HashSet<u64>) -> Vec<u64> {
    issues
        .iter()
        .filter(|issue| crate::forge::has_processing_label(&issue.labels))
        .filter(|issue| !owned.contains(&issue.number))
        .map(|issue| issue.number)
        .collect()
}

/// Writes a fully formed claim beside its final path and links it into place,
/// so no reader ever parses a half-written record.
fn write_issue_claim(path: &Path, claim: &Value) -> std::io::Result<()> {
    use std::io::Write as _;
    let staged = PathBuf::from(format!(
        "{}.new-{}-{}",
        path.display(),
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staged)?;
        file.write_all(format!("{}\n", crate::jsjson::stringify(claim)).as_bytes())?;
        std::fs::hard_link(&staged, path)
    })();
    let _ = std::fs::remove_file(&staged);
    result
}

/// Takes the issue's claim for the run that owns it. A claim that no longer
/// proves its owner is reclaimed here, in the same pass that wants the issue.
fn claim_issue(
    repo_dir: &Path,
    state_dir: &Path,
    number: u64,
    run_id: &str,
    version: Option<&str>,
) -> bool {
    if std::fs::create_dir_all(claims_directory(repo_dir)).is_err() {
        return false;
    }
    let path = claim_path(repo_dir, number);
    let claim = json!({
        "number": number,
        "pid": std::process::id(),
        "startTicks": crate::supervision::start_ticks(std::process::id()),
        "runId": run_id,
        "harnessVersion": version,
    });
    for _attempt in 0..3 {
        match write_issue_claim(&path, &claim) {
            Ok(()) => return true,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let Some(existing) = read_issue_claim(repo_dir, number) else {
                    // A damaged record proves no owner; it is replaced.
                    let _ = std::fs::remove_file(&path);
                    continue;
                };
                if existing.pid == std::process::id() && existing.run_id == run_id {
                    return true;
                }
                if claim_is_live(state_dir, repo_dir, &existing) {
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

/// Removes every claim and worker lock whose owner no longer proves
/// ownership. A live owner's file is left byte-identical.
fn prune_dead_owners(state_dir: &Path, repo_dir: &Path) {
    if let Ok(entries) = std::fs::read_dir(claims_directory(repo_dir)) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let claim = std::fs::read_to_string(&path)
                .ok()
                .and_then(|text| parse_claim(&text));
            match claim {
                Some(claim) if !claim_is_live(state_dir, repo_dir, &claim) => {
                    let _ = std::fs::remove_file(&path);
                }
                // Unparseable proves no dead owner; a claim still being
                // written is left for its writer.
                _ => {}
            }
        }
    }
    let base = lock_path(repo_dir);
    let Some(directory) = base.parent() else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.starts_with("lock") {
            continue;
        }
        let Some(owner) = read_lock(&entry.path()) else {
            continue;
        };
        if !owner_alive(&owner) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
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
    let text = crate::sampling::text(path)?;
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

/// The Open issues list: the open issues the dashboard's own forge read
/// returned, plus every issue a live worker reports it is processing.
///
/// The dashboard reads the tracker on its own slower cadence, so a worker can
/// start a run for an issue that read does not list yet: the Queue page then
/// claimed "No open issues." while the Runs and Agents pages showed that issue
/// under implementation. A live run is proof the issue was open when its
/// worker last read the tracker, so that worker's row is added until the
/// dashboard's read catches up. A row the read already lists wins, because the
/// read is the newer of the two.
fn queue_rows(open: Option<Vec<Issue>>, states: &[IssuesState]) -> Vec<QueuedIssue> {
    let mut rows: Vec<QueuedIssue> = open
        .unwrap_or_default()
        .iter()
        .map(|issue| QueuedIssue::from_issue(issue, None, None))
        .collect();
    for state in states {
        for issue in &state.queue {
            if issue.agent_run_id.is_none() {
                continue;
            }
            if rows.iter().any(|row| row.number == issue.number) {
                continue;
            }
            rows.push(issue.clone());
        }
    }
    rows.sort_by_key(|issue| issue.number);
    rows
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
    /// The pid's kernel start tick: without it a recycled pid cannot be told
    /// from the worker this record names.
    #[serde(default)]
    start_ticks: Option<i64>,
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

thread_local! {
    /// The state documents one thread has parsed. A document is sampled once
    /// per content change, so this count is the evidence that a rebuild
    /// re-parses nothing it already read. It is per thread so a test measures
    /// its own build, and production pays one thread-local read per parse.
    static STATE_PARSES: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// The state documents this thread has parsed since the last
/// [`reset_state_parses`].
pub fn state_parses() -> u64 {
    STATE_PARSES.with(|parses| parses.get())
}

/// Clears this thread's parse count, so a test starts from a known number.
pub fn reset_state_parses() {
    STATE_PARSES.with(|parses| parses.set(0));
}

/// Parses one document; `None` means the bytes are not this version.
fn parse_state(text: &str) -> Option<IssuesState> {
    STATE_PARSES.with(|parses| parses.set(parses.get() + 1));
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

/// One document's parsed state, kept for as long as its content is unchanged.
struct StateSample {
    modified: std::time::SystemTime,
    len: u64,
    state: Option<Arc<IssuesState>>,
}

/// The parsed state of every document this process has read, keyed by path.
static STATE_SAMPLES: std::sync::LazyLock<Mutex<HashMap<PathBuf, StateSample>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// One state document, parsed once per content change.
///
/// The stamp check is the contract [`crate::sampling`] applies to the bytes and
/// this one applies to the parse: an unchanged document costs one `stat`, never
/// a re-parse. A checkout keeps one document per worker version it ever ran, so
/// the projection's read of them is proportional to that history — sixty
/// four-megabyte documents here, which made one rebuild cost hundreds of
/// milliseconds on a 250 ms cadence and on every action's answer.
fn sample_state(path: &Path) -> Option<Arc<IssuesState>> {
    let Some((modified, len)) = crate::sampling::stamp(path) else {
        forget_state(path);
        return None;
    };
    if let Ok(samples) = STATE_SAMPLES.lock() {
        if let Some(sample) = samples.get(path) {
            if sample.len == len && sample.modified == modified {
                return sample.state.clone();
            }
        }
    }
    let state = crate::sampling::text(path)
        .and_then(|text| parse_state(&text))
        .map(Arc::new);
    if let Ok(mut samples) = STATE_SAMPLES.lock() {
        samples.insert(
            path.to_path_buf(),
            StateSample {
                modified,
                len,
                state: state.clone(),
            },
        );
    }
    state
}

/// Drops one path's parsed state, so a vanished document is parsed again when
/// it returns.
fn forget_state(path: &Path) {
    if let Ok(mut samples) = STATE_SAMPLES.lock() {
        samples.remove(path);
    }
}

fn read_state(path: &Path) -> Option<IssuesState> {
    // Sampled through the shared cache: the dashboard's 250 ms refresh never
    // re-reads, and never re-parses, an unchanged state file.
    sample_state(path).map(|state| (*state).clone())
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
    let Some(text) = crate::sampling::text(path) else {
        return (None, None);
    };
    let state = parse_state(&text);
    if state.is_none() {
        quarantine(path);
    }
    (state, Some(text.to_string()))
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

/// One run record under the Issues state directory. The Issues API and the
/// Runs view read the same file through [`parse_run_value`], so a record one
/// of them rejects is a record the other never lists either.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunFile {
    pub(crate) version: u64,
    pub(crate) run_id: String,
    pub(crate) repo: String,
    pub(crate) status: String,
    pub(crate) argv: Vec<String>,
    pub(crate) cwd: String,
    pub(crate) started_at: String,
    pub(crate) finished_at: Option<String>,
    pub(crate) exit_code: Option<i64>,
    pub(crate) issues: Vec<Issue>,
    pub(crate) first_stderr_line: Option<String>,
    pub(crate) worker_pid: u32,
    /// The worker's kernel start tick, the identity `worker_pid` alone cannot
    /// prove once the kernel reuses the pid. Absent on records written before
    /// it was kept.
    #[serde(default)]
    pub(crate) start_ticks: Option<i64>,
    pub(crate) harness_version: Option<String>,
}

fn parse_run_file(text: &str) -> Option<RunFile> {
    parse_run_value(&serde_json::from_str(text).ok()?)
}

/// The one record rule: `version: 1` with every field its writer emits and one
/// of the four statuses a run lifecycle can name. An unknown status, or a
/// record missing `argv`, `cwd`, or `issues`, is not a run.
pub(crate) fn parse_run_value(value: &Value) -> Option<RunFile> {
    let object = value.as_object()?;
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
    let start_ticks = match object.get("startTicks") {
        None | Some(Value::Null) => None,
        Some(value) => Some(value.as_i64()?),
    };
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
        start_ticks,
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

pub(crate) fn write_run_file(directory: &Path, run: &RunFile) -> std::io::Result<()> {
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
    crate::sampling::text(&activity_path(directory))
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
    let Some(text) = crate::sampling::text(&path) else {
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
/* Operator-close records                                                    */
/* ------------------------------------------------------------------------ */

/// One issue an operator closed from the dashboard, with the runs the close
/// must leave working.
#[derive(Debug, Clone, PartialEq, Eq)]
struct OperatorClose {
    run_ids: Vec<String>,
    /// When the close was recorded, so a tracker read that began before it
    /// cannot be mistaken for proof that the issue reopened.
    closed_at: Option<String>,
}

/// Records a close an operator dispatched from the dashboard and the runs it
/// leaves working.
///
/// Kept apart from the self-close records: those prove a run closed its own
/// issue and feed its success verification, while this only says the close came
/// from the row, so the worker's next read does not stop the runs it names.
pub fn record_operator_closed(state_dir: &Path, repo_dir: &Path, number: u64, run_ids: &[String]) {
    if run_ids.is_empty() {
        return;
    }
    write_operator_close(state_dir, repo_dir, number, run_ids, &iso_now());
}

fn write_operator_close(
    state_dir: &Path,
    repo_dir: &Path,
    number: u64,
    run_ids: &[String],
    closed_at: &str,
) {
    let directory = operator_closed_directory(state_dir, repo_dir);
    let _ = std::fs::create_dir_all(&directory);
    let path = directory.join(format!("{number}.json"));
    let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    let body = json!({"runIds": run_ids, "closedAt": closed_at}).to_string();
    if std::fs::write(&temporary, format!("{body}\n")).is_ok() {
        let _ = std::fs::rename(&temporary, &path);
    }
}

fn operator_close(state_dir: &Path, repo_dir: &Path, number: u64) -> Option<OperatorClose> {
    let text = std::fs::read_to_string(
        operator_closed_directory(state_dir, repo_dir).join(format!("{number}.json")),
    )
    .ok()?;
    let parsed: Value = serde_json::from_str(&text).ok()?;
    let run_ids: Vec<String> = parsed
        .get("runIds")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(Value::as_str)
        .filter(|run_id| !run_id.is_empty())
        .map(str::to_string)
        .collect();
    if run_ids.is_empty() {
        return None;
    }
    Some(OperatorClose {
        run_ids,
        closed_at: parsed
            .get("closedAt")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

/// True when an operator closed this issue while this run was working it.
fn operator_closed_run(state_dir: &Path, repo_dir: &Path, number: u64, run_id: &str) -> bool {
    operator_close(state_dir, repo_dir, number)
        .map(|close| close.run_ids.iter().any(|recorded| recorded == run_id))
        .unwrap_or(false)
}

/// Forgets one settled run's operator close, keeping the issue's other runs.
fn clear_operator_closed_run(state_dir: &Path, repo_dir: &Path, number: u64, run_id: &str) {
    let Some(close) = operator_close(state_dir, repo_dir, number) else {
        return;
    };
    if !close.run_ids.iter().any(|recorded| recorded == run_id) {
        return;
    }
    let mut run_ids = close.run_ids;
    run_ids.retain(|recorded| recorded != run_id);
    if run_ids.is_empty() {
        let _ = std::fs::remove_file(
            operator_closed_directory(state_dir, repo_dir).join(format!("{number}.json")),
        );
        return;
    }
    let closed_at = close.closed_at.unwrap_or_else(iso_now);
    write_operator_close(state_dir, repo_dir, number, &run_ids, &closed_at);
}

/// Forgets every operator close the tracker lists as open again.
///
/// A read that began before the close answered from the tracker state that still
/// listed the issue open, so it is not proof of a reopen and the record stays
/// for a read that began after it.
fn clear_reopened_operator_closes(
    state_dir: &Path,
    repo_dir: &Path,
    open: &HashSet<u64>,
    read_started_at: i64,
) {
    let Ok(entries) = std::fs::read_dir(operator_closed_directory(state_dir, repo_dir)) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(stem) = name.strip_suffix(".json") else {
            continue;
        };
        let Ok(number) = stem.parse::<u64>() else {
            continue;
        };
        if !open.contains(&number) {
            continue;
        }
        let Some(close) = operator_close(state_dir, repo_dir, number) else {
            let _ = std::fs::remove_file(entry.path());
            continue;
        };
        let closed_at = close
            .closed_at
            .as_deref()
            .and_then(parse_iso)
            .map(epoch_millis)
            .unwrap_or(i64::MIN);
        if closed_at > read_started_at {
            continue;
        }
        let _ = std::fs::remove_file(entry.path());
    }
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
            let source = crate::forge::TrackerSource::resolve(&repo_dir, &environment);
            let Some(remote) = source.remote.clone() else {
                return PollResult::Error {
                    detail: source.operation(crate::forge::OPEN_ISSUES_READ),
                };
            };
            let base_url = crate::forge::gitea_base_url(Some(&remote), &environment);
            let options = crate::forge::TrackerOptions {
                forge: remote.forge,
                repository: request.repository,
                etag: request.etag,
                run: None,
                environment,
                timeout_ms: Some(timeout_ms),
                base_url,
                transport: None,
            };
            let polled = source.poll_result(
                crate::forge::OPEN_ISSUES_READ,
                crate::forge::poll_open_issues(&options).await,
            );
            map_poll_result(polled)
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
    /// The resolved origin every error and deadline sentence names.
    source: crate::forge::TrackerSource,
    interval_ms: u64,
    timeout_ms: u64,
    inner: Mutex<SyncInner>,
    notify: tokio::sync::Notify,
}

impl TrackerSync {
    fn new(
        read: TrackerRead,
        repository: Arc<dyn Fn() -> Option<String> + Send + Sync>,
        source: crate::forge::TrackerSource,
        interval_ms: u64,
        timeout_ms: u64,
    ) -> Self {
        Self {
            read,
            repository,
            source,
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
            let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            // An origin that names no forge is the reason there is nothing to
            // read: the Overview says so instead of staying silent.
            if self.source.remote.is_none() {
                inner.error = Some(self.source.operation(crate::forge::OPEN_ISSUES_READ));
            }
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
            let detail = self
                .source
                .deadline(crate::forge::OPEN_ISSUES_READ, self.timeout_ms);
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
/// Writes or clears one issue's `processing` label.
pub type ProcessingFn = Arc<
    dyn Fn(u64, bool) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>> + Send + Sync,
>;

/// Everything one dashboard bridge needs from its process.
#[derive(Clone)]
pub struct IssuesHooks {
    pub preflight: PreflightFn,
    pub spawn_worker: SpawnFn,
    pub close_issue: CloseFn,
    pub tracker_read: TrackerRead,
    pub agent_environment: EnvironmentFn,
    pub processing_write: ProcessingFn,
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
    let source = crate::forge::TrackerSource::resolve(&request.repo_dir, &request.environment);
    let Some(remote) = source.remote.clone() else {
        return PreflightResult::Refused {
            message: format!(
                "the issues console cannot start: the checkout's origin does not name a \
                 supported forge ({})",
                source.problem.as_deref().unwrap_or("the origin is unknown")
            ),
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
///
/// A GitHub or Gitea close goes through the shared forge client, which resolves
/// the one write credential the close needs. A resolution ahead of it validated
/// the same account a second time, spending two more authenticated repository
/// and account round trips — hundreds of milliseconds each — on every close.
async fn production_close_issue(request: CloseIssueRequest) -> Result<(), String> {
    let source = crate::forge::TrackerSource::resolve(&request.repo_dir, &request.environment);
    let Some(remote) = source.remote.as_ref() else {
        return Err(source.operation("issue close"));
    };
    if remote.forge == crate::forge::Forge::GitLab {
        return close_gitlab_issue(request, remote).await;
    }
    // `gh`/`glab` argv and the Gitea PATCH live in the shared client, which
    // resolves the one write credential this close needs. Resolving a
    // credential ahead of it validated the same account a second time: two
    // more authenticated round trips, hundreds of milliseconds each, before
    // the close's own write.
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

/// Closes one GitLab issue through `glab`, which has no `--reason` and must
/// never fall through to `gh`. The CLI carries no credential of its own, so the
/// write credential is resolved here before the close runs.
async fn close_gitlab_issue(
    request: CloseIssueRequest,
    remote: &crate::forge::ForgeRemote,
) -> Result<(), String> {
    let mut resolve = crate::forge::ResolveOptions::new(
        remote.forge,
        remote.host.clone(),
        request.repository.clone(),
        request.repo_dir.clone(),
    );
    resolve.required = crate::forge::RequiredAccess::Write;
    resolve.env = request.environment.clone();
    resolve.deadline_ms =
        Some(crate::forge::now_millis() + crate::forge::DEFAULT_COMMAND_TIMEOUT_MS as i64);
    resolve.base_url = crate::forge::gitea_base_url(Some(remote), &request.environment);
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
    run_forge_close(
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
    .await
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

/// The detached worker's argv: the resolved harness worker entry point.
fn worker_argv(repo_dir: &Path, state_dir: &Path) -> Result<Vec<String>, String> {
    let program = crate::relaunch::harness_program(repo_dir)?;
    Ok(vec![
        program.to_string_lossy().into_owned(),
        "worker".to_string(),
        "issues".to_string(),
        "--repo".to_string(),
        repo_dir.display().to_string(),
        "--state-dir".to_string(),
        state_dir.display().to_string(),
    ])
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

/// What one Start owes its caller before any slow work runs.
enum StartAcceptance {
    /// The start ended before it began, naming the reason.
    Refused { message: String },
    /// A live worker serves the checkout, or this Start shares another's spawn.
    Answered { attached: bool },
    /// This call accepted the start and owes its spawn. `inline` means no
    /// worker has to stop first, so the spawn runs on the answer's own turn.
    Accepted { generation: u64, inline: bool },
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
        let processing_repo = repo_dir.to_path_buf();
        let processing_environment = environment.clone();
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
            processing_write: Arc::new(move |number, active| {
                let repo = processing_repo.clone();
                let environment = processing_environment.clone();
                Box::pin(async move {
                    let source = crate::forge::TrackerSource::resolve(&repo, &environment);
                    let Some(remote) = source.remote else {
                        return Err(source.operation(crate::forge::PROCESSING_WRITE));
                    };
                    write_processing(&repo, &remote.project, &environment, number, active).await
                })
            }),
        }
    }
}

/// One built Issues projection and its serialized frame, so a page poll
/// answers from what the bridge already published instead of rebuilding it.
struct CachedProjection {
    snapshot: Value,
    frame_text: String,
    /// The worker the build found attached, which is what clears a Start that
    /// worker answered. An answer assembled from this projection reads it
    /// instead of rebuilding the state to find it again.
    attached_worker: Option<WorkerRecord>,
}

/// The Start facts one projection reports: whether a Start this dashboard
/// accepted is still in flight, the reason a Start was refused, and the worker
/// the projection names for it.
struct StartEvidence {
    starting: bool,
    error: Option<String>,
    worker: Option<WorkerRecord>,
}

#[derive(Default)]
struct BridgeInner {
    last_signature: String,
    /// The last built projection. `replay` and the mode gate answer from it;
    /// `refresh` and an action's reply replace it.
    cached: Option<CachedProjection>,
    last_activities: HashMap<String, Vec<String>>,
    run_versions: HashMap<String, Option<String>>,
    stopping: HashMap<u32, u64>,
    abandoned: HashSet<String>,
    started: bool,
    sync_stopped: bool,
    /// When the supervisor last tried to replace a vanished worker.
    resume_attempt: Option<std::time::Instant>,
    /// The worker's last published poll time the bridge has projected.
    last_worker_poll: Option<String>,
    /// A Start this dashboard accepted whose stop proof, preflight, or spawn
    /// still runs. It is answered before any of that work, so the page learns
    /// the start is in flight instead of waiting on a forge read.
    starting: bool,
    /// Why the last accepted Start spawned nothing. Cleared by the next
    /// accepted Start, so a refusal never outlives the attempt it answered.
    start_error: Option<String>,
    /// The worker one accepted Start spawned, until that worker publishes the
    /// state naming it. The pid exists the moment the spawn returns, so the
    /// projection names it instead of showing a start with no worker; a spawn
    /// whose process exits before publishing is refused by name instead of
    /// leaving `starting` in force for the page forever.
    start_worker: Option<WorkerRecord>,
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
    /// A worker spawn a test installed, answering instead of the hooks'. A
    /// test drives a Start without starting a process.
    spawn_override: Mutex<Option<SpawnFn>>,
    /// The provider environment a test installed, answering instead of the
    /// hooks'. A test drives a Start without a configured provider.
    environment_override: Mutex<Option<EnvironmentFn>>,
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
            crate::forge::TrackerSource::resolve(&repo_dir, &options.environment),
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
            spawn_override: Mutex::new(None),
            environment_override: Mutex::new(None),
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

    /// The state of a live worker this dashboard owns, if one is serving the
    /// repository right now.
    ///
    /// A live worker reads the tracker on its own interval and publishes the
    /// result in its state. The bridge reads the tracker only when no such
    /// worker exists, so one interval costs one forge read, not two.
    fn attached_worker_state(&self) -> Option<IssuesState> {
        let owners: Vec<LockOwner> = self
            .owners()
            .into_iter()
            .filter(|owner| !self.foreign_owner(owner))
            .collect();
        if owners.is_empty() {
            return None;
        }
        let states = self.all_states();
        owners.iter().find_map(|owner| {
            states
                .iter()
                .find(|state| {
                    state
                        .worker
                        .as_ref()
                        .map(|worker| worker.pid == owner.pid)
                        .unwrap_or(false)
                })
                .cloned()
        })
    }

    /// Projects a worker's newest published read through the issue hook.
    fn publish_worker_read(&self, state: &IssuesState) {
        let Some(poll_at) = state.poll.last_poll_at.clone() else {
            return;
        };
        // Only a fresh listing is a new result; a conditional answer repeats
        // the issues the hook already published.
        if state.poll.not_modified || state.poll.error.is_some() {
            return;
        }
        let fresh = {
            let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            if inner.last_worker_poll.as_deref() == Some(poll_at.as_str()) {
                false
            } else {
                inner.last_worker_poll = Some(poll_at);
                true
            }
        };
        if !fresh || state.queue.is_empty() {
            return;
        }
        let issues: Vec<Issue> = state
            .queue
            .iter()
            .map(|row| Issue {
                number: row.number,
                title: row.title.clone(),
                url: row.url.clone(),
                created_at: row.created_at.clone(),
                labels: row.labels.clone(),
                body: row.body.clone(),
            })
            .collect();
        (self.on_open_issues)(issues);
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
        let version = crate::sampling::text(&path)
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

    /// A current projection, rebuilt now. A caller that asks for the state
    /// reflects the files as they stand.
    pub fn snapshot(&self) -> Value {
        self.refresh_projection().snapshot
    }

    /// The projection the bridge already published, built on first use. A
    /// page's poll answers from this, so one snapshot serves every viewer.
    fn cached_projection(&self) -> CachedProjection {
        if let Ok(inner) = self.inner.lock() {
            if let Some(cached) = &inner.cached {
                return CachedProjection {
                    snapshot: cached.snapshot.clone(),
                    frame_text: cached.frame_text.clone(),
                    attached_worker: cached.attached_worker.clone(),
                };
            }
        }
        self.refresh_projection()
    }

    /// Rebuilds the projection and stores it with its serialized frame.
    fn refresh_projection(&self) -> CachedProjection {
        let (snapshot, attached_worker) = self.build_snapshot();
        let frame = Self::typed_snapshot(snapshot.clone());
        let frame_text = crate::jsjson::stringify(&frame);
        if let Ok(mut inner) = self.inner.lock() {
            inner.cached = Some(CachedProjection {
                snapshot: snapshot.clone(),
                frame_text: frame_text.clone(),
                attached_worker: attached_worker.clone(),
            });
        }
        CachedProjection {
            snapshot,
            frame_text,
            attached_worker,
        }
    }

    fn build_snapshot(&self) -> (Value, Option<WorkerRecord>) {
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
        let attached_worker = if attached && !attached_pairs.is_empty() {
            active.as_ref().and_then(|state| state.worker.clone())
        } else {
            None
        };
        let start = self.start_evidence(attached_worker.clone());
        let worker = start.worker.clone();
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
        // A live worker's published queue is the interval's single read: the
        // bridge shows it instead of reading the same issues again.
        let queue = match attached.then(|| newest.first()).flatten() {
            Some(state) => state.queue.clone(),
            None => self.queue_for(&live_states),
        };
        map.insert(
            "queue".into(),
            Value::Array(
                queue
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
        map.insert("starting".into(), Value::Bool(start.starting));
        map.insert(
            "startError".into(),
            start
                .error
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
        map.insert(
            "updatedAt".into(),
            updated_at.map(Value::String).unwrap_or(Value::Null),
        );
        map.insert("workers".into(), Value::Array(workers));
        let sync = match attached.then(|| newest.first()).flatten() {
            Some(state) => SyncView {
                interval_ms: state.poll.interval_ms,
                last_sync_at: state.poll.last_poll_at.clone(),
                error: state.poll.error.clone(),
            },
            None => self.tracker.view(),
        };
        map.insert(
            "sync".into(),
            serde_json::to_value(sync).unwrap_or(Value::Null),
        );
        (Value::Object(map), attached_worker)
    }

    /// The Start facts a projection reports.
    ///
    /// A Start this dashboard accepted is its own fact, not a worker's: it
    /// exists before the spawned worker has published any state. `starting`
    /// stays in force until the projection can name that worker's pid, and a
    /// worker this dashboard spawned is named from the spawn itself, so no
    /// frame ever clears `starting` with neither a worker nor a reason.
    fn start_evidence(&self, attached_worker: Option<WorkerRecord>) -> StartEvidence {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let answered = attached_worker
            .as_ref()
            .map(|worker| !inner.stopping.contains_key(&worker.pid))
            .unwrap_or(false);
        if inner.starting && answered {
            inner.starting = false;
            inner.start_error = None;
            inner.start_worker = None;
        }
        let starting = inner.starting;
        let error = inner.start_error.clone();
        let spawned = inner.start_worker.clone();
        drop(inner);
        StartEvidence {
            starting,
            error,
            worker: attached_worker.or_else(|| spawned.filter(|_| starting)),
        }
    }

    /// The rows this dashboard serves. The `processing` label marks a run in
    /// progress only while a live claim owns that issue, so a label a stopped,
    /// killed, or upgraded-away run left behind never keeps a row running.
    fn queue_for(&self, states: &[IssuesState]) -> Vec<QueuedIssue> {
        let owned = claimed_issue_numbers(&self.state_dir, &self.repo_dir);
        let mut rows = queue_rows(self.tracker.open_issues(), states);
        for row in &mut rows {
            if !owned.contains(&row.number) {
                row.labels
                    .retain(|label| label != crate::forge::PROCESSING_LABEL);
            }
        }
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
        let cached = self.cached_projection();
        conn.send_payload(cached.frame_text);
        for run_id in self.active_run_ids(&cached.snapshot) {
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
    ///
    /// The state it answers with is the projection this bridge already
    /// published, restated with the Start facts the action changed. Rebuilding
    /// it here read and parsed every worker document this checkout ever wrote —
    /// sixty of them, four megabytes — inside the operator's request, so an
    /// action's answer cost hundreds of milliseconds and the one-second budget
    /// was missed whenever the sampling cache was cold. The projection is
    /// published on its own cadence, so file-derived fields are at most one
    /// cadence old when an answer restates them.
    pub fn reply(&self, conn: &Conn) {
        conn.send_payload(self.answer_frame());
    }

    /// The frame one action answers with: the published projection, restated
    /// with the Start facts the action changed, and kept as the projection the
    /// next read answers from.
    fn answer_frame(&self) -> String {
        let cached = self.cached_projection();
        let start = self.start_evidence(cached.attached_worker.clone());
        let mut snapshot = cached.snapshot;
        if let Value::Object(object) = &mut snapshot {
            object.insert("starting".into(), Value::Bool(start.starting));
            object.insert(
                "startError".into(),
                start.error.map(Value::String).unwrap_or(Value::Null),
            );
            object.insert(
                "worker".into(),
                start
                    .worker
                    .map(|worker| serde_json::to_value(worker).unwrap_or(Value::Null))
                    .unwrap_or(Value::Null),
            );
        }
        let frame_text = crate::jsjson::stringify(&Self::typed_snapshot(snapshot.clone()));
        if let Ok(mut inner) = self.inner.lock() {
            inner.cached = Some(CachedProjection {
                snapshot,
                frame_text: frame_text.clone(),
                attached_worker: cached.attached_worker,
            });
        }
        frame_text
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
        self.settle_vanished_start();
        let cached = self.refresh_projection();
        let signature = cached.frame_text;
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
            (self.send)(Self::typed_snapshot(cached.snapshot.clone()), None);
        }
        let run_ids = self.active_run_ids(&cached.snapshot);
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
        match self.begin_start() {
            StartAcceptance::Refused { message } => self.refuse_start(message),
            StartAcceptance::Answered { attached } => StartOutcome::Started { attached },
            StartAcceptance::Accepted { inline: true, .. } => {
                match self.start_after_stop_proof().await {
                    StartOutcome::Refused { message } => self.refuse_start(message),
                    started => started,
                }
            }
            StartAcceptance::Accepted { generation, .. } => {
                self.start_in_background(generation);
                StartOutcome::Started { attached: false }
            }
        }
    }

    /// Applies one operator Start and answers the page that asked.
    ///
    /// The answer is one `issuesState` frame: the refusal when the start ended
    /// before it began, else the state that names the worker this Start
    /// spawned. A spawn that refuses still answers the state the start
    /// changed; its refusal and journal record follow.
    pub async fn start_answering(self: &Arc<Self>, conn: &Conn) {
        self.auto_resume_suspended.store(false, Ordering::SeqCst);
        let _guard = self.start_lock.lock().await;
        match self.begin_start() {
            StartAcceptance::Refused { message } => {
                self.refuse_start(message);
                self.answer_start_refusal(conn);
            }
            StartAcceptance::Answered { .. } => self.reply(conn),
            StartAcceptance::Accepted { generation, inline } => {
                let accepted = self.answer_frame();
                self.answer_accepted(conn, accepted, generation, inline)
                    .await;
            }
        }
    }

    /// Accepts one Start: the state it changes, or the fact that a worker
    /// already serves it.
    ///
    /// `inline` is true when no worker has to stop first, so the spawn can run
    /// on the answer's own turn and name its pid.
    fn begin_start(&self) -> StartAcceptance {
        let owners = self.owners();
        if let Some(foreign) = owners.iter().find(|owner| self.foreign_owner(owner)) {
            return StartAcceptance::Refused {
                message: format!(
                    "this checkout already has an issues worker (pid {}) using {}; this dashboard's STATE_DIR is {}",
                    foreign.pid,
                    foreign.state_dir,
                    self.state_dir.display()
                ),
            };
        }
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let live = owners
            .iter()
            .any(|owner| !inner.stopping.contains_key(&owner.pid));
        if live {
            // A live worker already serves this checkout; the answer is the
            // state it is in, and nothing runs in the background.
            inner.starting = false;
            inner.start_error = None;
            inner.start_worker = None;
            return StartAcceptance::Answered { attached: true };
        }
        if inner.starting {
            // Concurrent Starts share one spawn and preflight; a second one is
            // answered instead of starting a second worker.
            return StartAcceptance::Answered { attached: false };
        }
        inner.starting = true;
        inner.start_error = None;
        inner.start_worker = None;
        let generation = self.start_generation.fetch_add(1, Ordering::SeqCst) + 1;
        StartAcceptance::Accepted {
            generation,
            inline: owners.is_empty(),
        }
    }

    /// Runs one accepted Start's stop proof, spawn, and preflight in its own
    /// task; its outcome reaches the state and the journal as it settles.
    fn start_in_background(self: &Arc<Self>, generation: u64) {
        let bridge = Arc::clone(self);
        tokio::spawn(async move {
            let outcome = bridge.run_start(generation).await;
            bridge.finish_start(generation, outcome);
        });
    }

    /// Answers one accepted Start with a single state frame.
    ///
    /// With no worker to stop first, the spawn runs before the answer, so a
    /// spawned worker is named by the pid in it. A spawn that refuses still
    /// answers the state the Start changed; its refusal and journal record
    /// follow, and the page reads them on its next state read.
    async fn answer_accepted(
        self: &Arc<Self>,
        conn: &Conn,
        accepted: String,
        generation: u64,
        inline: bool,
    ) {
        if !inline {
            self.start_in_background(generation);
            conn.send_payload(accepted);
            return;
        }
        match self.start_after_stop_proof().await {
            StartOutcome::Refused { message } => {
                self.refuse_start(message);
                conn.send_payload(accepted);
            }
            StartOutcome::Started { attached } => {
                if attached {
                    conn.send_payload(accepted);
                } else {
                    // The state that names the worker this Start spawned.
                    self.reply(conn);
                }
            }
        }
    }

    /// True once a Stop or a later Start owns the attempt `generation` named.
    fn start_superseded(&self, generation: u64) -> bool {
        self.start_generation.load(Ordering::SeqCst) != generation
    }

    /// Records one synchronous Start refusal and answers it.
    fn refuse_start(&self, message: String) -> StartOutcome {
        self.record_start_refusal(&message);
        StartOutcome::Refused { message }
    }

    /// The stop proof, then the spawn: the half a worker that still has to
    /// exit makes slow. A Start with nothing to stop skips this loop entirely.
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
        self.start_after_stop_proof().await
    }

    /// Spawns this version's worker, then asks the preflight beside it.
    ///
    /// The worker exists before the preflight is asked: a forge read slower
    /// than the page's budget must not hold the observable start back. A
    /// refusal settles beside it, stopping that worker and leaving the named
    /// reason on the card.
    async fn start_after_stop_proof(self: &Arc<Self>) -> StartOutcome {
        let outcome = self.spawn().await;
        if !outcome.is_ok() {
            return outcome;
        }
        let worker = {
            let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            inner.start_worker.clone()
        };
        if let Some(worker) = worker {
            self.begin_start_preflight(worker.pid);
        }
        StartOutcome::Started { attached: false }
    }

    /// Runs one accepted Start's preflight beside the worker it spawned.
    fn begin_start_preflight(self: &Arc<Self>, pid: u32) {
        let generation = self.start_generation.load(Ordering::SeqCst);
        let bridge = Arc::clone(self);
        tokio::spawn(async move {
            let message = match bridge.preflight().await {
                Ok(()) => return,
                Err(message) => message,
            };
            if bridge.start_superseded(generation) {
                return;
            }
            bridge.terminate_spawned(pid).await;
            bridge.finish_start(generation, StartOutcome::Refused { message });
        });
    }

    /// Publishes one accepted Start's outcome to every page.
    ///
    /// A refusal names its reason and reaches the journal. A spawn that
    /// succeeded is not an outcome yet: its worker answers the start with the
    /// state that names its pid, so `starting` stays in force until then and
    /// no frame ever clears it with neither a worker nor a reason.
    fn finish_start(&self, generation: u64, outcome: StartOutcome) {
        if self.start_superseded(generation) {
            return;
        }
        match &outcome {
            StartOutcome::Refused { message } => self.record_start_refusal(message),
            StartOutcome::Started { attached } => {
                let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
                inner.starting = !attached;
                inner.start_error = None;
                if *attached {
                    inner.start_worker = None;
                }
            }
        }
        self.refresh();
    }

    /// Records one refused Start: the page's own state names the reason, and
    /// the dashboard journal keeps the record. A refusal that wrote no worker
    /// leaves no other trace, so this record is what `journal_search` finds.
    fn record_start_refusal(&self, message: &str) {
        {
            let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            inner.starting = false;
            inner.start_error = Some(message.to_string());
            inner.start_worker = None;
        }
        crate::journal::Journal::open(&self.state_dir, &self.repo_dir, 0).write(
            "activity",
            &format!("could not start the issues worker: {message}"),
            Some("issues"),
        );
    }

    /// Answers one refused Start with the state that names the reason. [`Self::start`]
    /// already recorded the refusal; this is only the answer, and it is one
    /// frame: every other page reads the same state on its own next read. The
    /// refusal is never an `error` frame: that channel raises a server
    /// notification and files a board issue against a fact the operator owns.
    fn answer_start_refusal(&self, conn: &Conn) {
        self.reply(conn);
    }

    /// Refuses a Start whose worker process exited before publishing the state
    /// that would answer it. Without this the page would keep the busy word
    /// and a Start it can never press again, which is not an answer.
    fn settle_vanished_start(&self) {
        let generation = self.start_generation.load(Ordering::SeqCst);
        let pid = {
            let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            if !inner.starting {
                return;
            }
            inner.start_worker.as_ref().map(|worker| worker.pid)
        };
        let Some(pid) = pid else {
            return;
        };
        if pid_alive(pid) || !self.owners().is_empty() {
            return;
        }
        self.finish_start(
            generation,
            StartOutcome::Refused {
                message: format!(
                    "the issues worker (pid {pid}) exited before it published its state; press Start to retry."
                ),
            },
        );
    }

    /// Forgets an accepted Start a Stop has superseded, so the state names no
    /// start that no longer runs. True when one was still pending.
    fn cancel_start(&self) -> bool {
        let (pending, spawned) = {
            let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            let pending = inner.starting;
            inner.starting = false;
            inner.start_error = None;
            (pending, inner.start_worker.take())
        };
        if let Some(worker) = spawned {
            // A Stop ends the worker an accepted Start spawned before it
            // published a lock: no control file can reach an owner that does
            // not exist yet.
            unsafe {
                libc::kill(worker.pid as libc::pid_t, libc::SIGTERM);
            }
        }
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

    /// Ends a worker this dashboard spawned, for a preflight that refused it
    /// before any lock existed for a control file to reach.
    async fn terminate_spawned(&self, pid: u32) {
        if !pid_alive(pid) {
            return;
        }
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
        let deadline = std::time::Instant::now() + Duration::from_millis(500);
        while pid_alive(pid) && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        if pid_alive(pid) {
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGKILL);
            }
        }
    }

    async fn spawn(self: &Arc<Self>) -> StartOutcome {
        let argv = match worker_argv(&self.repo_dir, &self.state_dir) {
            Ok(argv) => argv,
            Err(message) => return StartOutcome::Refused { message },
        };
        let override_environment = self
            .environment_override
            .lock()
            .ok()
            .and_then(|slot| slot.clone());
        let pending = match override_environment {
            Some(callback) => callback(),
            None => (self.hooks.agent_environment)(),
        };
        let base = match pending.await {
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
        let override_spawn = self
            .spawn_override
            .lock()
            .ok()
            .and_then(|slot| slot.clone());
        let spawned = match override_spawn {
            Some(callback) => callback(&argv, &environment),
            None => (self.hooks.spawn_worker)(&argv, &environment),
        };
        {
            let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            inner.start_worker = spawned.map(|pid| WorkerRecord {
                pid,
                start_ticks: crate::supervision::start_ticks(pid),
                started_at: crate::journal::now_iso8601(),
                state_dir: self.state_dir.display().to_string(),
                harness_version: self.running_version.clone(),
                argv: argv.clone(),
            });
        }
        match spawned {
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
        let outcome = (self.hooks.close_issue)(CloseIssueRequest {
            repo_dir: self.repo_dir.clone(),
            repository,
            number: number_value,
            environment: self.environment.clone(),
        })
        .await;
        if outcome.is_ok() {
            self.record_operator_close(number_value);
        }
        outcome
    }

    /// Records an operator's close of one issue and the runs working it, so the
    /// worker's next read leaves them running.
    fn record_operator_close(&self, number: u64) {
        let run_ids: Vec<String> = self
            .all_states()
            .iter()
            .flat_map(|state| state.agents.iter())
            .filter(|agent| agent.issue_number == number)
            .map(|agent| agent.run_id.clone())
            .collect();
        record_operator_closed(&self.state_dir, &self.repo_dir, number, &run_ids);
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
        let run = crate::sampling::text(&run_file_path(&directory))
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
        // A live worker owns the tracker read for this repository: it reads
        // once per interval and publishes the result, and the bridge projects
        // that result. Reading the same issues here made every interval cost
        // two forge requests, each one a token use on the forge's busiest
        // table.
        if let Some(state) = self.attached_worker_state() {
            self.publish_worker_read(&state);
            self.refresh();
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
        }
        // The projection is built before any repair write: `queue_for` serves
        // an unclaimed label as pending, so a slow or failing clear never
        // delays the queue.
        self.refresh();
        if result.fresh {
            if let Some(issues) = &result.issues {
                (self.on_open_issues)(issues.clone());
                self.repair_stale_processing(issues).await;
            }
        }
    }

    /// Clears every `processing` label this read lists with no live claim
    /// behind it. The Issues worker repairs the label on its own poll, but a
    /// stopped or killed worker never polls again, so the dashboard — the
    /// other always-on reader of exactly that list — repairs it here. A failed
    /// write is retried by the next fresh read; the row never keeps running,
    /// because `queue_for` hides a label no claim owns.
    async fn repair_stale_processing(&self, issues: &[Issue]) {
        let owned = claimed_issue_numbers(&self.state_dir, &self.repo_dir);
        for number in unclaimed_processing(issues, &owned) {
            // A claim written after the read belongs to a run that just
            // started; its label is not stale, so it is never cleared.
            if claimed_issue_numbers(&self.state_dir, &self.repo_dir).contains(&number) {
                continue;
            }
            if let Err(detail) = (self.hooks.processing_write)(number, false).await {
                eprintln!("issues: could not clear the processing label on #{number}: {detail}");
            }
        }
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
                    // A goal issue's close stays that goal's cancellation, so
                    // only a run an operator's row close left working is spared.
                    state_issue_is_goal(&state, agent.issue_number)
                        || !operator_closed_run(
                            &self.state_dir,
                            &self.repo_dir,
                            agent.issue_number,
                            &agent.run_id,
                        )
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

/// Answers every later Start spawn with `callback` instead of the hooks'. A
/// test drives a Start through its answer without starting a process.
pub fn set_spawn(app: &Arc<App>, callback: SpawnFn) {
    if let Some(bridge) = bridge_for(app) {
        if let Ok(mut slot) = bridge.spawn_override.lock() {
            *slot = Some(callback);
        }
    }
}

/// Resolves every later Start's worker environment with `callback` instead of
/// the hooks'. A test drives a Start without a configured provider.
pub fn set_agent_environment(
    app: &Arc<App>,
    callback: impl Fn() -> EnvironmentFuture + Send + Sync + 'static,
) {
    if let Some(bridge) = bridge_for(app) {
        if let Ok(mut slot) = bridge.environment_override.lock() {
            *slot = Some(Arc::new(callback));
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

/// The refusal a Start answers with when this dashboard never registered an
/// Issues bridge.
pub const NO_ISSUES_BRIDGE_REFUSAL: &str =
    "this dashboard has no Issues mode; restart the dashboard and press Start again.";

/// Answers a Start in a dashboard that never registered an Issues bridge.
///
/// The answer is the card's own state, never the generic `error` channel: that
/// channel raises a server notification and files a board issue, and this
/// refusal is a fact about this dashboard that the operator can read and
/// retry from.
pub fn answer_start_without_bridge(app: &Arc<App>, conn: &Conn) {
    app.shared.journal.write(
        "activity",
        &format!("could not start the issues worker: {NO_ISSUES_BRIDGE_REFUSAL}"),
        Some("issues"),
    );
    conn.send(start_refusal_state(
        &app.config().repo_dir,
        NO_ISSUES_BRIDGE_REFUSAL,
    ));
}

/// One `issuesState` frame that names a refused Start and no worker.
fn start_refusal_state(repo_dir: &Path, message: &str) -> Value {
    json!({
        "type": "issuesState",
        "present": false,
        "repo": null,
        "root": repo_dir.display().to_string(),
        "lifecycle": "stopped",
        "enabled": false,
        "paused": false,
        "attached": false,
        "worker": null,
        "poll": null,
        "queue": [],
        "runs": [],
        "agents": [],
        "cooldowns": {},
        "lastError": null,
        "lastExitCode": null,
        "finishedAt": null,
        "notice": null,
        "deferral": null,
        "starting": false,
        "startError": message,
        "updatedAt": null,
        "workers": [],
    })
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
            let requested = run_id.as_ref().unwrap_or(&missing);
            let detail = bridge_for(app).and_then(|bridge| bridge.run(requested));
            match detail {
                Some(run) => conn.send(json!({"type": "issuesRun", "run": run})),
                // A pruned or restored history entry is a normal answer for a
                // read, so it carries its own frame: the generic error channel
                // turns every frame into a Server error notification, and the
                // focus page already renders this run as unavailable.
                None => conn.send(json!({
                    "type": "issuesRunMissing",
                    "runId": requested,
                    "message": "No such issues run.",
                })),
            }
            true
        }
        Command::StartIssues => {
            let Some(bridge) = bridge_for(app) else {
                answer_start_without_bridge(app, conn);
                return true;
            };
            // The answer is one state frame: the refusal, or the state that
            // names the worker this Start spawned. It is never an `error`
            // frame and never the whole activity a page's own read replays.
            bridge.start_answering(conn).await;
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
    /// The resolved origin the worker's tracker errors name.
    tracker_source: crate::forge::TrackerSource,
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
        let tracker_source = crate::forge::TrackerSource::resolve(&repo_dir, &environment);
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
            tracker_source,
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
        // Every claim and lock whose owner no longer holds it is removed
        // before this worker reads the queue. A live owner is left untouched.
        prune_dead_owners(&self.state_dir, &self.repo_dir);

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
            if entry.run.status != "running" {
                continue;
            }
            // A record another harness version left `running` is rewritten by
            // no worker: once the process it names no longer runs, nothing can
            // own the run, so it is closed here instead of surviving every
            // restart as a running history entry the Runs view reports
            // stopped. The recorded start tick, not the bare pid, proves that
            // process: a pid the kernel recycled for an unrelated process
            // belongs to nobody this record wrote.
            let orphaned = entry.run.worker_pid != std::process::id()
                && !crate::supervision::live_identity(entry.run.worker_pid, entry.run.start_ticks);
            if orphaned
                || entry.run.worker_pid == std::process::id()
                || entry.run.harness_version == self.harness_version
            {
                interrupted.insert(entry.run.run_id.clone());
            }
        }
        for run_id in interrupted {
            self.close_interrupted_run(&run_id);
        }
        self.prune_history();
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
            start_ticks: crate::supervision::start_ticks(std::process::id()),
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
        let pending: Vec<u64> = self
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
            .map(|issue| issue.number)
            .collect();
        if pending.is_empty() {
            return "idle".into();
        }
        // A live claim another worker owns is not this worker's failure: it
        // may start none of that work, and the pass names the owner. Reading
        // `failed` here told the operator a healthy worker had broken.
        if pending.iter().all(|number| self.claimed_elsewhere(*number)) {
            return "idle".into();
        }
        "failed".into()
    }

    /// True when a live process outside this one holds this issue's claim, so
    /// this worker must leave the issue alone. This process's own claim is not
    /// another owner, and a claim that proves no owner is reclaimable.
    fn claimed_elsewhere(&self, number: u64) -> bool {
        if self.claiming.contains(&number) {
            return false;
        }
        match read_issue_claim(&self.repo_dir, number) {
            None => false,
            Some(claim) => {
                claim.pid != std::process::id()
                    && claim_is_live(&self.state_dir, &self.repo_dir, &claim)
            }
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
                let detail = self
                    .tracker_source
                    .deadline(crate::forge::OPEN_ISSUES_READ, TRACKER_TIMEOUT_MS);
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
                        self.apply_issues(issues, epoch_millis(started_at)).await;
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
        // This worker's own runs hold a live claim; the active set is the
        // local proof for a claim released a moment before its label clears.
        let mut owned = claimed_issue_numbers(&self.state_dir, &self.repo_dir);
        owned.extend(self.active.keys().copied());
        for number in unclaimed_processing(issues, &owned) {
            if let Err(detail) = write_processing(
                &self.repo_dir,
                &self.state.repo,
                &self.environment,
                number,
                false,
            )
            .await
            {
                eprintln!("issues: could not clear the processing label on #{number}: {detail}");
            }
        }
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

    async fn apply_issues(&mut self, issues: Vec<Issue>, read_started_at: i64) {
        let open: HashSet<u64> = issues.iter().map(|issue| issue.number).collect();
        clear_reopened_operator_closes(&self.state_dir, &self.repo_dir, &open, read_started_at);
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
        // Every proven live owner outside this process that holds a queued
        // issue, with the harness version its worker state records, so a pass
        // that starts none of them names who does.
        let mut held_elsewhere: BTreeMap<u32, (Option<String>, usize)> = BTreeMap::new();
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
            if self.claimed_elsewhere(issue.number) {
                count_claim_holder(
                    &mut held_elsewhere,
                    &self.state_dir,
                    &self.repo_dir,
                    issue.number,
                );
                continue;
            }
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
            // The owning run record is written before the claim, so a live
            // claim always has a `running` run from its first instant.
            let active = match self.open_run(&issue) {
                Ok(active) => active,
                Err((run_id, directory, error)) => {
                    self.fail_without_peer(&issue, &run_id, &directory, &error);
                    continue;
                }
            };
            if !claim_issue(
                &self.repo_dir,
                &self.state_dir,
                issue.number,
                &active.run_id,
                self.harness_version.as_deref(),
            ) {
                self.close_refused_run(&active);
                count_claim_holder(
                    &mut held_elsewhere,
                    &self.state_dir,
                    &self.repo_dir,
                    issue.number,
                );
                continue;
            }
            self.claiming.insert(issue.number);
            self.begin(issue, permit, active).await;
            if self.stopping || self.state.paused || !self.state.enabled {
                break;
            }
        }
        if deferral.is_none() && !held_elsewhere.is_empty() {
            let count: usize = held_elsewhere.values().map(|(_, count)| *count).sum();
            let holders = held_elsewhere
                .iter()
                .map(|(pid, (version, _))| {
                    format!(
                        "harness {} (pid {pid})",
                        version.as_deref().unwrap_or("unknown")
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            deferral = Some(format!(
                "{count} queued issue(s) are claimed by {holders}; the start is deferred"
            ));
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
            start_ticks: crate::supervision::start_ticks(std::process::id()),
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

    async fn begin(
        &mut self,
        issue: Issue,
        permit: Option<crate::resources::Slot>,
        mut active: WorkerActive,
    ) {
        if !self.set_processing(issue.number, true).await {
            if self.claiming.remove(&issue.number) {
                release_issue_claim(&self.repo_dir, issue.number);
            }
            let finished_at = iso_now();
            let detail = format!(
                "could not mark issue #{} as processing on the tracker",
                issue.number
            );
            self.update_run(
                &active.run_id,
                &active.directory,
                "failed",
                &finished_at,
                Some(1),
                Some(detail.clone()),
            );
            self.state.cooldowns.insert(
                issue.number.to_string(),
                iso_from_millis(epoch_millis(OffsetDateTime::now_utc()) + COOLDOWN_MS as i64),
            );
            self.state.last_error = Some(detail);
            self.state.lifecycle = self.settled_lifecycle();
            self.publish();
            return;
        }
        if self.stopping {
            self.set_processing(issue.number, false).await;
            if self.claiming.remove(&issue.number) {
                release_issue_claim(&self.repo_dir, issue.number);
            }
            let finished_at = iso_now();
            self.update_run(
                &active.run_id,
                &active.directory,
                "stopped",
                &finished_at,
                None,
                None,
            );
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

    /// Closes a run whose claim another live worker already owns. No peer
    /// starts for it, and it is never reported as this worker's failure.
    fn close_refused_run(&mut self, active: &WorkerActive) {
        let finished_at = iso_now();
        self.update_run(
            &active.run_id,
            &active.directory,
            "stopped",
            &finished_at,
            None,
            None,
        );
    }

    async fn forget(&mut self, number: u64, run_id: &str) {
        if self.claiming.remove(&number) {
            release_issue_claim(&self.repo_dir, number);
        }
        self.active.remove(&number);
        self.state.agents.retain(|agent| agent.run_id != run_id);
        clear_closed_by_run(&self.state_dir, &self.repo_dir, number, run_id);
        clear_operator_closed_run(&self.state_dir, &self.repo_dir, number, run_id);
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
        // An operator's row close leaves this run working; a goal issue's close
        // is that goal's cancellation and still settles below.
        if !is_goal_issue(&active.issue)
            && operator_closed_run(&self.state_dir, &self.repo_dir, number, &active.run_id)
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

    /// Keeps every running run and the newest `RUN_HISTORY_LIMIT` finished run
    /// directories, and removes the rest.
    ///
    /// The walk is the run directory listing, not `self.runs`: `load_runs`
    /// stops after `RUN_HISTORY_LIMIT` finished records, so a directory it
    /// skipped would otherwise stay invisible to this pruner forever.
    fn prune_history(&mut self) {
        let runs_root = runs_directory(&self.state_dir, &self.repo_dir);
        let running: HashSet<String> = self
            .runs
            .iter()
            .filter(|entry| entry.run.status == "running")
            .map(|entry| entry.directory.display().to_string())
            .collect();
        let mut kept: HashSet<String> = HashSet::new();
        let mut finished = 0;
        for name in list_run_directories(&self.state_dir, &self.repo_dir) {
            let directory = runs_root.join(&name);
            let display = directory.display().to_string();
            if running.contains(&display) {
                kept.insert(display);
                continue;
            }
            if finished < RUN_HISTORY_LIMIT {
                finished += 1;
                kept.insert(display);
                continue;
            }
            let _ = std::fs::remove_dir_all(&directory);
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
    remote: &crate::forge::ForgeRemote,
    repository: &str,
    environment: &HashMap<String, String>,
) -> crate::forge::TrackerOptions {
    let base_url = crate::forge::gitea_base_url(Some(remote), environment);
    crate::forge::TrackerOptions {
        forge: remote.forge,
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
    let source = crate::forge::TrackerSource::resolve(repo_dir, environment);
    let Some(remote) = source.remote.as_ref() else {
        return IssueStateResult::Error {
            detail: source.operation(crate::forge::ISSUE_STATE_READ),
        };
    };
    let options = tracker_options(remote, repository, environment);
    match crate::forge::fetch_issue_state(&options, number as i64).await {
        crate::forge::IssueStateResult::State(state) => IssueStateResult::State {
            closed: state == crate::forge::IssueState::Closed,
        },
        crate::forge::IssueStateResult::Error { detail } => IssueStateResult::Error {
            detail: source.failure(crate::forge::ISSUE_STATE_READ, &detail),
        },
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
    let source = crate::forge::TrackerSource::resolve(repo_dir, environment);
    let Some(remote) = source.remote.as_ref() else {
        return Err(source.operation(crate::forge::PROCESSING_WRITE));
    };
    let options = tracker_options(remote, repository, environment);
    match crate::forge::write_issue_processing(&options, number as i64, active).await {
        crate::forge::ProcessingWriteResult::Ok => Ok(()),
        crate::forge::ProcessingWriteResult::Error { detail } => {
            Err(source.failure(crate::forge::PROCESSING_WRITE, &detail))
        }
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

    /// A checkout whose `origin` names a Gitea repository, so the shared forge
    /// client resolves that forge instead of a real one.
    fn forge_checkout(label: &str, remote: &str) -> PathBuf {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!("issues-forge-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("a checkout");
        for args in [vec!["init", "-q"], vec!["remote", "add", "origin", remote]] {
            let status = std::process::Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(&args)
                .status()
                .expect("git");
            assert!(status.success(), "git {args:?}");
        }
        root
    }

    /// The slow path this pins: the hook resolved the write credential itself
    /// and then handed the same work to the shared client, and the client read
    /// the closed issue back after its write. One operator click therefore
    /// spent seven forge round trips where three suffice — and on the loaded
    /// tracker this dashboard talks to, every authenticated one costs about as
    /// much as the whole 1000 ms budget allows for all of them.
    #[tokio::test]
    async fn a_close_hook_spends_one_credential_resolution_and_one_write() {
        const ANSWER_MS: u64 = 200;
        let calls: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&calls);
        let app = axum::Router::new().fallback(move |request: axum::extract::Request| {
            let recorded = Arc::clone(&recorded);
            async move {
                let method = request.method().as_str().to_string();
                let path = request.uri().path().to_string();
                recorded
                    .lock()
                    .expect("calls")
                    .push((method.clone(), path.clone()));
                tokio::time::sleep(Duration::from_millis(ANSWER_MS)).await;
                let body = if method == "PATCH" {
                    json!({
                        "number": 7,
                        "title": "Seven",
                        "html_url": "http://gitea.test/owner/name/issues/7",
                        "created_at": "2024-01-02T03:04:05Z",
                        "state": "closed",
                        "body": "body 7",
                        "labels": [],
                    })
                } else if path.ends_with("/user") {
                    json!({"login": "alice"})
                } else {
                    json!({
                        "full_name": "owner/name",
                        "private": false,
                        "permissions": {"pull": true, "push": true, "admin": false},
                    })
                };
                axum::response::Response::builder()
                    .status(200)
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(body.to_string()))
                    .expect("a stub answer")
            }
        });
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("a stub listener");
        let port = listener.local_addr().expect("an address").port();
        let serving = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let base = format!("http://127.0.0.1:{port}");
        let repo = forge_checkout("close", "git@localhost:owner/name.git");
        let environment = crate::forge::environment(&[
            ("DEVBOARD_GITEA_URL", base.as_str()),
            ("GITEA_TOKEN", "secret"),
        ]);

        let started = std::time::Instant::now();
        production_close_issue(CloseIssueRequest {
            repo_dir: repo,
            repository: "owner/name".to_string(),
            number: 7,
            environment,
        })
        .await
        .expect("a close");
        let elapsed = started.elapsed();
        serving.abort();

        let calls = calls.lock().expect("calls").clone();
        assert_eq!(
            calls,
            vec![
                ("GET".to_string(), "/api/v1/repos/owner/name".to_string()),
                ("GET".to_string(), "/api/v1/user".to_string()),
                (
                    "PATCH".to_string(),
                    "/api/v1/repos/owner/name/issues/7".to_string()
                ),
            ],
            "one credential resolution, the close write, and nothing else"
        );
        assert!(
            elapsed < Duration::from_millis(1000),
            "one close took {elapsed:?} against a forge answering in {ANSWER_MS} ms"
        );
    }

    fn worker(repo: &Path, state: &Path) -> IssuesWorker {
        worker_with_version(repo, state, "1.2.3")
    }

    fn worker_with_version(repo: &Path, state: &Path, version: &str) -> IssuesWorker {
        let mut worker = IssuesWorker::new(
            repo.to_path_buf(),
            state.to_path_buf(),
            100,
            "omp acp".to_string(),
            HashMap::new(),
            Some(version.to_string()),
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

    /// A `running` run record for a claim written by a stand-in worker.
    fn seed_running_run(state: &Path, repo: &Path, run_id: &str, version: &str, pid: u32) {
        let directory = run_directory(state, repo, run_id);
        std::fs::create_dir_all(&directory).expect("a run directory");
        let run = RunFile {
            version: 1,
            run_id: run_id.to_string(),
            repo: "acme/app".to_string(),
            status: "running".to_string(),
            argv: Vec::new(),
            cwd: repo.display().to_string(),
            started_at: iso_now(),
            finished_at: None,
            exit_code: None,
            issues: Vec::new(),
            first_stderr_line: None,
            worker_pid: pid,
            start_ticks: crate::supervision::start_ticks(pid),
            harness_version: Some(version.to_string()),
        };
        write_run_file(&directory, &run).expect("a run record");
    }

    fn seed_claim(repo: &Path, claim: Value) {
        std::fs::create_dir_all(claims_directory(repo)).expect("a claims directory");
        let number = claim["number"].as_u64().expect("a claim number");
        std::fs::write(
            claim_path(repo, number),
            format!("{}\n", crate::jsjson::stringify(&claim)),
        )
        .expect("a claim");
    }

    fn seed_lock(repo: &Path, version: Option<&str>, pid: u32) {
        let path = versioned_lock_path(repo, version);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("a lock directory");
        }
        let owner = LockOwner {
            pid,
            started_at: process_started_at(pid)
                .map(iso_from_millis)
                .unwrap_or_else(iso_now),
            repo: repo.display().to_string(),
            state_dir: String::new(),
            harness_version: version.map(str::to_string),
            argv: Vec::new(),
        };
        std::fs::write(&path, crate::jsjson::stringify(&owner.to_json())).expect("a lock");
    }

    /// Opens a run and claims its issue for this worker, as the pass does.
    fn claim_for(worker: &mut IssuesWorker, number: u64) {
        let issue = issue(number, &[]);
        let active = worker.open_run(&issue).expect("a run");
        let run_id = active.run_id.clone();
        worker.active.insert(number, active);
        assert!(claim_issue(
            &worker.repo_dir,
            &worker.state_dir,
            number,
            &run_id,
            worker.harness_version.as_deref(),
        ));
        worker.claiming.insert(number);
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

    /// A `running` record whose worker pid is dead and whose `harnessVersion`
    /// differs from the running one is closed on start: no worker of either
    /// version rewrites it, so leaving it is a permanent running history entry
    /// that the Runs view reports stopped.
    #[tokio::test]
    async fn start_closes_a_run_left_running_by_a_dead_worker_of_another_version() {
        let (repo, state) = unit_root("stale-running");
        let mut dead = std::process::Command::new("true")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("a stand-in worker");
        let pid = dead.id();
        let _ = dead.wait();
        assert!(
            !crate::supervision::live_process(pid),
            "the seeded pid names no live process"
        );
        let directory = run_directory(&state, &repo, "stale");
        std::fs::create_dir_all(&directory).expect("a run directory");
        let record = json!({
            "version": 1,
            "runId": "stale",
            "repo": "acme/app",
            "status": "running",
            "argv": [],
            "cwd": repo.display().to_string(),
            "startedAt": "2026-01-01T00:00:00.000Z",
            "finishedAt": null,
            "exitCode": null,
            "issues": [],
            "firstStderrLine": null,
            "workerPid": pid,
            "harnessVersion": "0.9.0",
        });
        std::fs::write(run_file_path(&directory), format!("{record}\n")).expect("a run record");

        let mut worker = worker(&repo, &state);
        assert_eq!(worker.harness_version.as_deref(), Some("1.2.3"));
        assert!(worker.start("acme/app"), "the worker starts");

        let text = std::fs::read_to_string(run_file_path(&directory)).expect("the record");
        let written: Value = serde_json::from_str(&text).expect("record JSON");
        assert_eq!(written["status"], json!("stopped"), "{written}");
        assert!(
            written["finishedAt"].is_string(),
            "a closed record carries its finish time: {written}"
        );
    }

    /// A stand-in process for the pid a seeded record names, killed by the
    /// caller when its assertions are done.
    fn stand_in() -> std::process::Child {
        std::process::Command::new("sleep")
            .arg("120")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("a stand-in worker")
    }

    /// A `running` record of another version whose pid the kernel has already
    /// handed to an unrelated process is closed on start: the recorded start
    /// tick proves that process is not the worker, so this record has no owner
    /// left and would otherwise stay a running history entry forever.
    #[tokio::test]
    async fn start_closes_a_run_whose_recycled_pid_names_an_unrelated_process() {
        let (repo, state) = unit_root("recycled-pid");
        let mut live = stand_in();
        let pid = live.id();
        let ticks = crate::supervision::start_ticks(pid).expect("the stand-in's start tick");
        assert!(
            crate::supervision::live_process(pid),
            "the seeded pid names a live process"
        );
        let directory = run_directory(&state, &repo, "recycled");
        std::fs::create_dir_all(&directory).expect("a run directory");
        let record = json!({
            "version": 1,
            "runId": "recycled",
            "repo": "acme/app",
            "status": "running",
            "argv": [],
            "cwd": repo.display().to_string(),
            "startedAt": "2026-01-01T00:00:00.000Z",
            "finishedAt": null,
            "exitCode": null,
            "issues": [],
            "firstStderrLine": null,
            "workerPid": pid,
            "startTicks": ticks + 1,
            "harnessVersion": "0.9.0",
        });
        std::fs::write(run_file_path(&directory), format!("{record}\n")).expect("a run record");

        let mut worker = worker(&repo, &state);
        assert!(worker.start("acme/app"), "the worker starts");
        let _ = live.kill();
        let _ = live.wait();

        let text = std::fs::read_to_string(run_file_path(&directory)).expect("the record");
        let written: Value = serde_json::from_str(&text).expect("record JSON");
        assert_eq!(written["status"], json!("stopped"), "{written}");
        assert!(
            written["finishedAt"].is_string(),
            "a closed record carries its finish time: {written}"
        );
    }

    /// The control for the recycled-pid case: a record whose pid and start tick
    /// still name the same live process keeps its owner, so another version's
    /// worker leaves it `running` rather than closing a run in flight.
    #[tokio::test]
    async fn start_leaves_a_run_running_while_its_recorded_identity_is_live() {
        let (repo, state) = unit_root("live-identity");
        let mut live = stand_in();
        let pid = live.id();
        let ticks = crate::supervision::start_ticks(pid).expect("the stand-in's start tick");
        let directory = run_directory(&state, &repo, "owned");
        std::fs::create_dir_all(&directory).expect("a run directory");
        let record = json!({
            "version": 1,
            "runId": "owned",
            "repo": "acme/app",
            "status": "running",
            "argv": [],
            "cwd": repo.display().to_string(),
            "startedAt": "2026-01-01T00:00:00.000Z",
            "finishedAt": null,
            "exitCode": null,
            "issues": [],
            "firstStderrLine": null,
            "workerPid": pid,
            "startTicks": ticks,
            "harnessVersion": "0.9.0",
        });
        std::fs::write(run_file_path(&directory), format!("{record}\n")).expect("a run record");

        let mut worker = worker(&repo, &state);
        assert!(worker.start("acme/app"), "the worker starts");
        let text = std::fs::read_to_string(run_file_path(&directory)).expect("the record");
        let _ = live.kill();
        let _ = live.wait();

        let written: Value = serde_json::from_str(&text).expect("record JSON");
        assert_eq!(written["status"], json!("running"), "{written}");
        assert!(
            written["finishedAt"].is_null(),
            "a run still owned carries no finish time: {written}"
        );
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
        worker
            .apply_issues(
                vec![issue(99, &[])],
                epoch_millis(OffsetDateTime::now_utc()),
            )
            .await;
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
        worker
            .apply_issues(Vec::new(), epoch_millis(OffsetDateTime::now_utc()))
            .await;
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
    async fn an_operator_close_leaves_the_run_working() {
        let (repo, state) = unit_root("operator-close-live");
        let mut worker = worker(&repo, &state);
        attach(&mut worker, issue(11, &[]));
        let run_id = worker.active[&11].run_id.clone();
        worker.state.agents.push(Agent {
            run_id: run_id.clone(),
            issue_number: 11,
            started_at: worker.active[&11].started_at.clone(),
            question: None,
            acp: None,
        });
        record_operator_closed(&state, &repo, 11, std::slice::from_ref(&run_id));
        worker
            .apply_issues(Vec::new(), epoch_millis(OffsetDateTime::now_utc()))
            .await;
        assert!(worker.active.contains_key(&11));
        assert!(worker
            .state
            .agents
            .iter()
            .any(|agent| agent.run_id == run_id));
        assert!(!worker.dismissed.contains_key(&11));
        assert!(
            worker.state.notice.is_none(),
            "no stopped notice: {:?}",
            worker.state.notice
        );
        // The run settles through its own turn and verification, and that
        // settlement forgets the operator's close.
        worker.record_succeeded(11).await;
        assert!(!operator_closed_run(&state, &repo, 11, &run_id));
    }

    #[tokio::test]
    async fn a_tracker_close_without_an_operator_record_stops_the_run() {
        let (repo, state) = unit_root("operator-close-absent");
        let mut worker = worker(&repo, &state);
        attach(&mut worker, issue(12, &[]));
        worker
            .apply_issues(Vec::new(), epoch_millis(OffsetDateTime::now_utc()))
            .await;
        assert!(worker.active.is_empty());
        assert!(worker.dismissed.contains_key(&12));
        assert_eq!(
            worker.state.notice.as_deref(),
            Some("Issue #12 was closed on the tracker; its run was stopped.")
        );
        let run = worker.runs.first().expect("the run");
        assert_eq!(run.run.status, "stopped");
    }

    #[tokio::test]
    async fn a_reopened_issue_clears_its_operator_close() {
        let (repo, state) = unit_root("operator-close-reopened");
        let mut worker = worker(&repo, &state);
        attach(&mut worker, issue(13, &[]));
        let run_id = worker.active[&13].run_id.clone();
        record_operator_closed(&state, &repo, 13, std::slice::from_ref(&run_id));
        // A read that began before the close answered from tracker state that
        // still listed the issue open; that is no proof of a reopen.
        worker.apply_issues(vec![issue(13, &[])], i64::MIN).await;
        assert!(operator_closed_run(&state, &repo, 13, &run_id));
        // A read that began after the close does prove it.
        worker
            .apply_issues(
                vec![issue(13, &[])],
                epoch_millis(OffsetDateTime::now_utc()),
            )
            .await;
        assert!(!operator_closed_run(&state, &repo, 13, &run_id));
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

    /// A claim another live worker owns must not read as this worker's
    /// failure: nothing starts, and the pass names the owner instead of
    /// publishing `failed` with no reason.
    #[tokio::test]
    async fn a_queue_claimed_by_another_live_worker_reads_idle_and_names_it() {
        let (repo, state) = unit_root("claim-held-elsewhere");
        let mut owner = stand_in();
        let ticks = crate::supervision::start_ticks(owner.id()).expect("the stand-in's start tick");
        seed_running_run(&state, &repo, "other-worker", "1.2.2", owner.id());
        seed_claim(
            &repo,
            json!({
                "number": 7,
                "pid": owner.id(),
                "startTicks": ticks,
                "runId": "other-worker",
                "harnessVersion": "1.2.2",
            }),
        );

        let mut worker = worker(&repo, &state);
        worker.agent_command = "/bin/false".to_string();
        let queued = issue(7, &[]);
        worker.state.queue = vec![worker.queued(&queued)];

        worker.maybe_trigger().await;

        assert!(worker.active.is_empty(), "the claim belongs to the owner");
        assert_eq!(worker.state.lifecycle, "idle");
        let line = worker
            .state
            .deferral
            .clone()
            .expect("the deferral names the owner");
        assert_eq!(
            line,
            format!(
                "1 queued issue(s) are claimed by harness 1.2.2 (pid {}); the start is deferred",
                owner.id()
            )
        );
        let published = read_state(&versioned_state_path(&state, &repo, Some("1.2.3")))
            .expect("the published state");
        assert_eq!(published.lifecycle, "idle");
        assert_eq!(published.deferral.as_deref(), Some(line.as_str()));

        let _ = owner.kill();
        let _ = owner.wait();
    }

    /// One pending issue no live owner holds keeps the failure: the worker
    /// could have started it and did not.
    #[tokio::test]
    async fn a_queue_only_partly_claimed_by_another_worker_keeps_the_failure() {
        let (repo, state) = unit_root("claim-held-partly");
        let mut owner = stand_in();
        let ticks = crate::supervision::start_ticks(owner.id()).expect("the stand-in's start tick");
        seed_running_run(&state, &repo, "other-worker", "1.2.2", owner.id());
        seed_claim(
            &repo,
            json!({
                "number": 7,
                "pid": owner.id(),
                "startTicks": ticks,
                "runId": "other-worker",
                "harnessVersion": "1.2.2",
            }),
        );

        let mut worker = worker(&repo, &state);
        let held = issue(7, &[]);
        let free = issue(8, &[]);
        worker.state.queue = vec![worker.queued(&held), worker.queued(&free)];
        assert_eq!(worker.settled_lifecycle(), "failed");

        worker.state.queue = vec![worker.queued(&held)];
        assert_eq!(worker.settled_lifecycle(), "idle");

        let _ = owner.kill();
        let _ = owner.wait();
    }

    /// A pid the kernel has already given to an unrelated process is no proof
    /// of ownership: the claim is reclaimed and the pass attempts the issue
    /// with no deferral line naming the stranger.
    #[tokio::test]
    async fn a_claim_with_a_recycled_pid_is_reclaimed() {
        let (repo, state) = unit_root("claim-recycled-pid");
        let mut stranger = stand_in();
        let ticks =
            crate::supervision::start_ticks(stranger.id()).expect("the stand-in's start tick");
        seed_claim(
            &repo,
            json!({
                "number": 7,
                "pid": stranger.id(),
                "startTicks": ticks + 1,
                "runId": "gone-run",
                "harnessVersion": "1.2.3",
            }),
        );

        let mut worker = worker(&repo, &state);
        worker.agent_command = "/definitely/not/a/devboard-agent".to_string();
        let queued = issue(7, &[]);
        worker.state.queue = vec![worker.queued(&queued)];
        worker.maybe_trigger().await;

        assert_eq!(worker.state.deferral, None, "no holder was proven");
        assert!(
            worker
                .runs
                .iter()
                .any(|entry| entry.run.issues.iter().any(|issue| issue.number == 7)),
            "the pass attempted the issue"
        );
        let claim = read_issue_claim(&repo, 7);
        assert!(
            claim.as_ref().map(|claim| claim.pid) != Some(stranger.id()),
            "the stale claim was reclaimed: {claim:?}"
        );

        let _ = stranger.kill();
        let _ = stranger.wait();
    }

    /// A legacy claim carries no start tick, so only a live worker lock naming
    /// the same pid and harness version proves it.
    #[tokio::test]
    async fn a_legacy_claim_needs_a_live_worker_lock() {
        let (repo, state) = unit_root("legacy-claim-lock");
        let mut holder = stand_in();
        let pid = holder.id();
        let legacy_claim = || {
            json!({
                "number": 7,
                "pid": pid,
                "runId": "legacy-run",
                "harnessVersion": "1.2.3",
            })
        };
        seed_running_run(&state, &repo, "other-run", "1.2.4", std::process::id());
        seed_claim(&repo, legacy_claim());
        let claim = read_issue_claim(&repo, 7).expect("the legacy claim");
        assert!(
            !claim_is_live(&state, &repo, &claim),
            "no lock proves the owner"
        );

        seed_lock(&repo, Some("1.2.3"), pid);
        let claim = read_issue_claim(&repo, 7).expect("the legacy claim");
        assert!(
            claim_is_live(&state, &repo, &claim),
            "the live lock proves the owner"
        );
        assert!(!claim_issue(&repo, &state, 7, "other-run", Some("1.2.4")));
        assert_eq!(
            read_issue_claim(&repo, 7).expect("the claim").run_id,
            "legacy-run"
        );

        std::fs::remove_file(versioned_lock_path(&repo, Some("1.2.3"))).expect("the lock");
        seed_lock(&repo, Some("1.2.4"), pid);
        seed_claim(&repo, legacy_claim());
        let claim = read_issue_claim(&repo, 7).expect("the legacy claim");
        assert!(
            !claim_is_live(&state, &repo, &claim),
            "a foreign version is no proof"
        );
        assert!(claim_issue(&repo, &state, 7, "other-run", Some("1.2.4")));
        assert_eq!(
            read_issue_claim(&repo, 7).expect("the claim").run_id,
            "other-run"
        );

        let _ = holder.kill();
        let _ = holder.wait();
    }

    /// The deferral names the version the holding worker's own run records,
    /// not a version the claim asserts about itself.
    #[tokio::test]
    async fn the_deferral_names_the_holding_worker_version() {
        let (repo, state) = unit_root("deferral-holder-version");
        let mut holder = stand_in();
        let pid = holder.id();
        let ticks = crate::supervision::start_ticks(pid).expect("the stand-in's start tick");
        seed_running_run(&state, &repo, "holder-run", "1.2.2", pid);
        seed_claim(
            &repo,
            json!({
                "number": 7,
                "pid": pid,
                "startTicks": ticks,
                "runId": "holder-run",
                "harnessVersion": "9.9.9",
            }),
        );

        let mut worker = worker(&repo, &state);
        worker.agent_command = "/definitely/not/a/devboard-agent".to_string();
        let queued = issue(7, &[]);
        worker.state.queue = vec![worker.queued(&queued)];
        worker.maybe_trigger().await;

        assert!(worker.active.is_empty(), "the claim belongs to the holder");
        assert_eq!(worker.state.lifecycle, "idle");
        assert_eq!(
            worker.state.deferral.as_deref(),
            Some(
                format!(
                    "1 queued issue(s) are claimed by harness 1.2.2 (pid {pid}); \
                     the start is deferred"
                )
                .as_str()
            )
        );
        let published = read_state(&versioned_state_path(&state, &repo, Some("1.2.3")))
            .expect("the published state");
        assert_eq!(published.lifecycle, "idle");
        assert_eq!(published.deferral, worker.state.deferral);

        let _ = holder.kill();
        let _ = holder.wait();
    }

    /// A start removes a dead owner's claim and lock and leaves a live
    /// owner's files byte-identical; running it again changes nothing.
    #[tokio::test]
    async fn a_dead_owners_claim_and_lock_are_pruned_on_start() {
        let (repo, state) = unit_root("prune-dead-owners");
        let mut dead = std::process::Command::new("true")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("a stand-in worker");
        let dead_pid = dead.id();
        let _ = dead.wait();
        let mut alive = stand_in();
        let alive_pid = alive.id();
        let ticks = crate::supervision::start_ticks(alive_pid).expect("the stand-in's start tick");

        seed_claim(
            &repo,
            json!({
                "number": 8,
                "pid": dead_pid,
                "startTicks": 1,
                "runId": "dead-run",
                "harnessVersion": "1.2.3",
            }),
        );
        seed_claim(
            &repo,
            json!({
                "number": 9,
                "pid": alive_pid,
                "startTicks": ticks,
                "runId": "live-run",
                "harnessVersion": "1.2.3",
            }),
        );
        seed_running_run(&state, &repo, "live-run", "1.2.3", alive_pid);
        seed_lock(&repo, Some("1.2.2"), alive_pid);
        seed_lock(&repo, Some("9.9.9"), dead_pid);

        let live_claim = std::fs::read(claim_path(&repo, 9)).expect("the live claim");
        let live_lock =
            std::fs::read(versioned_lock_path(&repo, Some("1.2.2"))).expect("the live lock");

        let mut worker = worker_with_version(&repo, &state, "1.2.4");
        assert!(worker.start("acme/app"), "the worker starts");

        assert!(
            !claim_path(&repo, 8).exists(),
            "the dead owner's claim is pruned"
        );
        assert_eq!(
            std::fs::read(claim_path(&repo, 9)).expect("the live claim"),
            live_claim,
            "a live owner's claim is untouched"
        );
        assert!(
            !versioned_lock_path(&repo, Some("9.9.9")).exists(),
            "the dead owner's lock is pruned"
        );
        assert_eq!(
            std::fs::read(versioned_lock_path(&repo, Some("1.2.2"))).expect("the live lock"),
            live_lock,
            "a live owner's lock is untouched"
        );

        let before = file_snapshot(claims_directory(&repo).parent().expect("the issues root"));
        prune_dead_owners(&state, &repo);
        let after = file_snapshot(claims_directory(&repo).parent().expect("the issues root"));
        assert_eq!(before, after, "a second prune changes nothing");

        let _ = alive.kill();
        let _ = alive.wait();
    }

    /// Every way a run ends releases the claim in the same pass.
    #[tokio::test]
    async fn an_ended_run_leaves_no_claim() {
        let (repo, state) = unit_root("ended-run-claim");
        let mut worker = worker(&repo, &state);

        claim_for(&mut worker, 1);
        worker.record_succeeded(1).await;
        assert!(
            !claim_path(&repo, 1).exists(),
            "a success releases its claim"
        );

        claim_for(&mut worker, 2);
        worker.record_failed(2, "boom".to_string()).await;
        assert!(
            !claim_path(&repo, 2).exists(),
            "a failure releases its claim"
        );

        claim_for(&mut worker, 3);
        worker
            .abandon_run(3, "closed on the tracker".to_string())
            .await;
        assert!(
            !claim_path(&repo, 3).exists(),
            "an abandonment releases its claim"
        );

        claim_for(&mut worker, 4);
        worker.issue_state_override = Some(Arc::new(|_| {
            Box::pin(async { IssueStateResult::State { closed: false } })
        }));
        worker.fail_silent_run(4, 60_000).await;
        assert!(
            !claim_path(&repo, 4).exists(),
            "a silent-run failure releases its claim"
        );

        claim_for(&mut worker, 5);
        worker.issue_state_override = None;
        worker
            .on_event(WorkerEvent::TurnEnded {
                number: 5,
                error: Some("the agent process exited".to_string()),
            })
            .await;
        assert!(
            !claim_path(&repo, 5).exists(),
            "a peer exit releases its claim"
        );
    }

    /// A second claimant of one issue takes nothing: one claim survives, and
    /// the loser starts no peer and closes the run it opened for the attempt.
    #[tokio::test]
    async fn two_workers_never_own_one_claim() {
        let (repo, state) = unit_root("two-claimants");
        let queued = issue(7, &[]);
        let mut winner = worker_with_version(&repo, &state, "1.2.3");
        let active = winner.open_run(&queued).expect("a run");
        let winner_run = active.run_id.clone();
        assert!(claim_issue(&repo, &state, 7, &winner_run, Some("1.2.3")));
        winner.active.insert(7, active);
        winner.claiming.insert(7);

        let mut loser = worker_with_version(&repo, &state, "1.2.4");
        loser.agent_command = "/definitely/not/a/devboard-agent".to_string();
        loser.state.queue = vec![loser.queued(&queued)];
        loser.maybe_trigger().await;

        assert!(loser.active.is_empty(), "the loser starts no peer");
        let claim = read_issue_claim(&repo, 7).expect("the one claim");
        assert_eq!(claim.run_id, winner_run);
        assert_eq!(live_issue_claims(&state, &repo).len(), 1);
        let running = winner
            .runs
            .iter()
            .chain(loser.runs.iter())
            .filter(|entry| entry.run.status == "running")
            .count();
        assert_eq!(running, 1, "exactly one run is running");
        assert_eq!(
            loser.runs.first().map(|entry| entry.run.status.as_str()),
            Some("stopped"),
            "the refused run is closed"
        );
        assert_eq!(
            loser.state.deferral.as_deref(),
            Some(
                format!(
                    "1 queued issue(s) are claimed by harness 1.2.3 (pid {}); \
                     the start is deferred",
                    std::process::id()
                )
                .as_str()
            )
        );
    }

    /// Every file below one directory, with its bytes, for an unchanged-file
    /// assertion.
    fn file_snapshot(directory: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        let mut files = BTreeMap::new();
        let Ok(entries) = std::fs::read_dir(directory) else {
            return files;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                files.extend(file_snapshot(&path));
            } else if let Ok(bytes) = std::fs::read(&path) {
                files.insert(path, bytes);
            }
        }
        files
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

    #[test]
    fn a_processed_issue_fills_an_empty_dashboard_read() {
        // The dashboard's own tracker read is slower than the worker's, so it
        // can list nothing while the worker is already implementing an issue:
        // the Queue page claimed "No open issues." beside two processing runs.
        let mut state = empty_state("acme/app", "repo", 1_000, "running");
        state.queue.push(QueuedIssue::from_issue(
            &issue(17, &["processing"]),
            None,
            Some("run-17".to_string()),
        ));
        let rows = queue_rows(Some(Vec::new()), std::slice::from_ref(&state));
        assert_eq!(
            rows.iter().map(|row| row.number).collect::<Vec<_>>(),
            vec![17]
        );
        assert_eq!(rows[0].agent_run_id.as_deref(), Some("run-17"));
    }

    #[test]
    fn an_issue_the_read_lists_is_not_duplicated_by_its_worker_row() {
        let mut state = empty_state("acme/app", "repo", 1_000, "running");
        state.queue.push(QueuedIssue::from_issue(
            &issue(17, &["processing"]),
            None,
            Some("run-17".to_string()),
        ));
        let rows = queue_rows(
            Some(vec![issue(17, &["processing"])]),
            std::slice::from_ref(&state),
        );
        assert_eq!(rows.len(), 1);
        assert!(rows[0].agent_run_id.is_none(), "the read's row wins");
    }

    #[test]
    fn an_unstarted_worker_row_waits_for_the_dashboard_read() {
        // A queued issue no run has started is still only as fresh as the
        // worker's last poll, so the read owns the list and this row is not
        // added: a stale worker queue must never resurrect an unstarted issue.
        let mut state = empty_state("acme/app", "repo", 1_000, "running");
        state
            .queue
            .push(QueuedIssue::from_issue(&issue(17, &["scout"]), None, None));
        let rows = queue_rows(Some(Vec::new()), std::slice::from_ref(&state));
        assert!(rows.is_empty());
    }
}

// __ISSUES_MODE_NEXT__

#[cfg(test)]
mod tick_bounds {
    //! The worker's control tick is a housekeeping cadence: at most four
    //! observations a second, never a busy loop.

    #[test]
    fn the_control_tick_is_at_least_250_ms() {
        // Read through a binding so the guard runs at test time: the point is
        // that a later edit to the constant cannot quietly restore a 100 ms
        // poll.
        let tick = super::WORKER_TICK_MS;
        assert!(tick >= 250, "the control tick is {tick} ms");
    }
}
