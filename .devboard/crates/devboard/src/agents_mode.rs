//! Background agent families: the shared registry, the bridge every family
//! answers through, the prompt pages, and the detached-worker dashboards.
//!
//! Auto Scout, Watchdog, Design System, Dead Code, MCP optimizer, API
//! Standards, Single Responsibility, and Release Train are one contract. The
//! dashboard only reads each worker's published state, replays its activity,
//! and writes commands into that worker's control directory; a worker started
//! here is detached in its own session, so killing this server leaves it
//! running and a replacement reattaches to the same board.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};
use time::macros::format_description;
use time::OffsetDateTime;

use crate::app::{App, Conn, Shared};
use crate::command::Command;

/* ------------------------------------------------------------------------ */
/* Shared vocabulary                                                         */
/* ------------------------------------------------------------------------ */

const LIFECYCLES: [&str; 5] = ["stopped", "starting", "running", "stopping", "failed"];
const SYNC_STATES: [&str; 3] = ["ok", "error", "stale"];
const ISSUE_STATES: [&str; 3] = ["pending", "implemented", "unknown"];

/// The default poll cadence of every family's dashboard half.
const POLL_MS: u64 = 250;
/// How long a spawned worker may take to publish its state before Start fails.
const START_PROOF_MS: i64 = 5_000;
/// Wall-clock bound for a family's Start preflight. A preflight that never
/// settles must answer with a refusal instead of leaving the family starting.
const AGENT_PREFLIGHT_TIMEOUT_MS: u64 = 20_000;
/// How much later than the preflight's own budget the outer guard fires, so a
/// slow step's named error wins over the generic refusal.
const PREFLIGHT_BUDGET_GRACE_MS: u64 = 1_000;
/// How much of a preflight step's window its request leaves unspent, so the
/// request's own named timeout reports before the step's generic deadline.
const PREFLIGHT_REQUEST_MARGIN_MS: u64 = 250;
/// The least window a retry needs to earn another attempt: a fast refusal
/// leaves the whole window, while a stalled request leaves none.
const PREFLIGHT_RETRY_WINDOW_MS: u64 = 2_000;
/// How long past its own preflight bound a Start may hold its family at
/// `starting` before the snapshot names it and resets the state. A command
/// whose future was dropped, and a start wedged behind an await that never
/// settles, never run their own cleanup, so the snapshot is the only guard.
const START_ABANDON_GRACE_MS: i64 = 2_000;

/// One Start preflight's wall clock, shared by every forge step it runs.
///
/// The steps used to carry their own twenty second timeouts while being
/// chained, so three slow forge reads could outlive the whole preflight and
/// surface only the generic refusal. Each step now gets the remaining budget,
/// so the preflight settles inside its bound and names the step that stalled.
#[derive(Debug, Clone, Copy)]
pub struct PreflightBudget {
    deadline: tokio::time::Instant,
}

impl PreflightBudget {
    pub fn new(timeout_ms: u64) -> Self {
        Self {
            deadline: tokio::time::Instant::now() + Duration::from_millis(timeout_ms.max(1)),
        }
    }

    /// Milliseconds left for the next step; never zero.
    pub fn remaining_ms(&self) -> u64 {
        let left = self
            .deadline
            .saturating_duration_since(tokio::time::Instant::now());
        u64::try_from(left.as_millis()).unwrap_or(u64::MAX).max(1)
    }

    /// The bound one forge request may spend: the step's remaining window, short
    /// of its end by [`PREFLIGHT_REQUEST_MARGIN_MS`], so the request's own named
    /// timeout reports before the step's generic deadline does.
    pub fn request_ms(&self) -> u64 {
        self.remaining_ms()
            .saturating_sub(PREFLIGHT_REQUEST_MARGIN_MS)
            .max(1)
    }

    /// Runs one step under the remaining budget, naming the step on expiry.
    pub async fn run<T>(
        &self,
        step: &str,
        work: impl Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        let remaining = self.remaining_ms();
        match crate::deadline::within_deadline(work, remaining).await {
            Some(result) => result,
            None => Err(format!(
                "{step} did not finish within {remaining} ms; press Start to retry."
            )),
        }
    }
}
/// The command's grace before the table's proof signals a worker.
const STOP_PROOF_MS: u64 = 3_000;
/// How long a proven worker gets after SIGTERM before SIGKILL.
const STOP_KILL_GRACE_MS: u64 = 2_000;
/// Start waits no longer than the whole stop proof window for the peer to exit.
const STOP_DEADLINE_MS: u64 = STOP_PROOF_MS + STOP_KILL_GRACE_MS;
const STOP_POLL_MS: u64 = 50;
/// A page open asks an attached worker for one fresh read at most this often.
const SYNC_REQUEST_MIN_INTERVAL_MS: i64 = 5_000;
/// A connected dashboard re-reads a table's forge state this often.
const AGENT_FORGE_INTERVAL_MS: i64 = 60_000;
/// A success older than this reads as stale until the next scheduled read.
const AGENT_FORGE_STALE_MS: i64 = 120_000;
/// Watchdog and MCP optimizer keep a live worker's cycle grace this long.
const STOP_CYCLE_GRACE_MS: u64 = 10 * 60_000;
/// The legacy timer gate is re-read in the background at most this often.
const TIMER_REFRESH_MS: i64 = 5_000;
/// A bounded documentation history.
const DOCUMENTATION_HISTORY_LIMIT: usize = 20;

/* ------------------------------------------------------------------------ */
/* Time                                                                      */
/* ------------------------------------------------------------------------ */

fn iso(dt: OffsetDateTime) -> String {
    let format =
        format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z");
    dt.format(&format)
        .unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".to_string())
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// The instant by which a Start must have spawned its worker or refused.
///
/// It outlasts the preflight's own bound by the abandonment grace, so a
/// preflight that refuses names itself instead of being reported as a start
/// that never finished.
fn start_deadline_at(now: i64, timeout_ms: u64) -> i64 {
    now + timeout_ms as i64 + PREFLIGHT_BUDGET_GRACE_MS as i64 + START_ABANDON_GRACE_MS
}

fn iso_from_millis(ms: i64) -> String {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .map(iso)
        .unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".to_string())
}

/// Parses the ISO 8601 form JS writes: `YYYY-MM-DDTHH:MM:SS[.mmm]Z`.
fn parse_millis(text: &str) -> Option<i64> {
    let text = text.trim();
    let text = text
        .strip_suffix('Z')
        .or_else(|| text.strip_suffix("+00:00"))?;
    let (date, time) = text.split_once('T')?;
    let mut date_parts = date.split('-');
    let year: i64 = date_parts.next()?.parse().ok()?;
    let month: i64 = date_parts.next()?.parse().ok()?;
    let day: i64 = date_parts.next()?.parse().ok()?;
    let mut time_parts = time.split(':');
    let hour: i64 = time_parts.next()?.parse().ok()?;
    let minute: i64 = time_parts.next()?.parse().ok()?;
    let seconds_text = time_parts.next()?;
    let (second, fraction) = match seconds_text.split_once('.') {
        Some((second, fraction)) => (second, fraction),
        None => (seconds_text, ""),
    };
    let second: i64 = second.parse().ok()?;
    let millis: i64 = if fraction.is_empty() {
        0
    } else {
        let digits: String = fraction.chars().take(3).collect();
        let padded = format!("{digits:0<3}");
        padded.parse().ok()?
    };
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    // Days from the civil date to the Unix epoch (Howard Hinnant's algorithm).
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1_000 + millis)
}

/* ------------------------------------------------------------------------ */
/* Descriptors                                                               */
/* ------------------------------------------------------------------------ */

#[derive(Clone, Copy)]
enum PromptKind {
    File(&'static str),
    Absent,
    Template(&'static str),
}

#[derive(Clone, Copy)]
struct Descriptor {
    id: &'static str,
    label: &'static str,
    description: &'static str,
    scope: &'static str,
    prompt: PromptKind,
    default_minutes: u32,
    min_minutes: u32,
    max_minutes: u32,
    max_per_hour: Option<u32>,
    max_pending: Option<u32>,
    panel: &'static str,
    timer_unit: Option<&'static str>,
}

const DESCRIPTORS: [Descriptor; 9] = [
    Descriptor {
        id: "scout",
        label: "Auto Scout",
        description: "Scans the repository and files significant findings as issues.",
        scope: "repository",
        prompt: PromptKind::File("scout-recommendations.md"),
        default_minutes: 1,
        min_minutes: 1,
        max_minutes: 1440,
        max_per_hour: Some(10),
        max_pending: Some(5),
        panel: "activity",
        timer_unit: None,
    },
    Descriptor {
        id: "watchdog",
        label: "Watchdog",
        description: "Watches dashboard evidence and files significant machine findings as issues.",
        scope: "machine",
        prompt: PromptKind::Absent,
        default_minutes: 10,
        min_minutes: 1,
        max_minutes: 1440,
        max_per_hour: None,
        max_pending: None,
        panel: "cycles",
        timer_unit: Some("devboard-watchdog.timer"),
    },
    Descriptor {
        id: "design",
        label: "Design System",
        description: "Audits the interface against its documented design system and files capped issues for every divergence.",
        scope: "repository",
        prompt: PromptKind::File("design-system.md"),
        default_minutes: 60,
        min_minutes: 1,
        max_minutes: 1440,
        max_per_hour: Some(10),
        max_pending: Some(5),
        panel: "activity",
        timer_unit: None,
    },
    Descriptor {
        id: "dead-code",
        label: "Dead Code",
        description: "Proves dead code from a seeded entry point and files capped removal issues for every finding.",
        scope: "repository",
        prompt: PromptKind::File("dead-code-removal.md"),
        default_minutes: 60,
        min_minutes: 1,
        max_minutes: 1440,
        max_per_hour: Some(10),
        max_pending: Some(5),
        panel: "activity",
        timer_unit: None,
    },
    Descriptor {
        id: "mcp-optimizer",
        label: "MCP optimizer",
        description: "Reviews repeated agent mistakes and manual work and files one improvement issue per pattern.",
        scope: "repository",
        prompt: PromptKind::Template(
            "MCP optimizer synthesizes its prompt from each cycle's evidence, so this generated template is read-only.",
        ),
        default_minutes: 60,
        min_minutes: 1,
        max_minutes: 1440,
        max_per_hour: Some(10),
        max_pending: Some(20),
        panel: "cycles",
        timer_unit: None,
    },
    Descriptor {
        id: "api-standards",
        label: "API Standards",
        description: "Audits the dashboard HTTP API against the project REST skill and files capped conformance issues for every MUST or SHOULD violation.",
        scope: "repository",
        prompt: PromptKind::File("api-standards.md"),
        default_minutes: 60,
        min_minutes: 1,
        max_minutes: 1440,
        max_per_hour: Some(10),
        max_pending: Some(5),
        panel: "activity",
        timer_unit: None,
    },
    Descriptor {
        id: "single-responsibility",
        label: "Single Responsibility",
        description: "Audits the repository source against the project Single Responsibility skill and files one capped issue per component and violation.",
        scope: "repository",
        prompt: PromptKind::File("single-responsibility.md"),
        default_minutes: 60,
        min_minutes: 1,
        max_minutes: 1440,
        max_per_hour: Some(10),
        max_pending: Some(5),
        panel: "activity",
        timer_unit: None,
    },
    Descriptor {
        id: "consistent-naming",
        label: "Consistent Naming",
        description: "Audits the repository's vocabulary against the project naming skill and files one capped vocabulary issue per concept and violation.",
        scope: "repository",
        prompt: PromptKind::File("consistent-naming.md"),
        default_minutes: 60,
        min_minutes: 1,
        max_minutes: 1440,
        max_per_hour: Some(10),
        max_pending: Some(5),
        panel: "activity",
        timer_unit: None,
    },
    Descriptor {
        id: "release-train",
        label: "Release Train",
        description: "Releases every unreleased commit on main on its scheduled cadence, one version per collected range.",
        scope: "repository",
        prompt: PromptKind::File("release-train.md"),
        default_minutes: 10,
        min_minutes: 1,
        max_minutes: 1440,
        max_per_hour: None,
        max_pending: None,
        panel: "activity",
        timer_unit: None,
    },
];

fn descriptor(id: &str) -> Option<&'static Descriptor> {
    DESCRIPTORS.iter().find(|entry| entry.id == id)
}

/* ------------------------------------------------------------------------ */
/* Snapshot projection                                                       */
/* ------------------------------------------------------------------------ */

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Limits {
    max_per_hour: Option<u32>,
    max_pending: Option<u32>,
}

impl Limits {
    fn to_json(self) -> Value {
        json!({
            "maxPerHour": self.max_per_hour.map(|value| json!(value)).unwrap_or(Value::Null),
            "maxPending": self.max_pending.map(|value| json!(value)).unwrap_or(Value::Null),
        })
    }
}

#[derive(Clone, Debug, Default)]
struct AgentSync {
    state: String,
    at: Option<String>,
    error: Option<String>,
}

impl AgentSync {
    fn stale() -> Self {
        Self {
            state: "stale".to_string(),
            at: None,
            error: None,
        }
    }

    fn to_json(&self) -> Value {
        json!({
            "state": self.state,
            "at": self.at,
            "error": self.error,
        })
    }
}

#[derive(Clone, Debug)]
struct Worker {
    pid: u32,
    version: Option<String>,
    state_dir: String,
    lifecycle: String,
}

impl Worker {
    fn to_json(&self) -> Value {
        json!({
            "pid": self.pid,
            "version": self.version,
            "stateDir": self.state_dir,
            "lifecycle": self.lifecycle,
        })
    }
}

#[derive(Clone, Debug, Default)]
struct TimerGate {
    unit: String,
    state: String,
    blocked: bool,
    error: Option<String>,
}

impl TimerGate {
    fn to_json(&self) -> Value {
        json!({
            "unit": self.unit,
            "state": self.state,
            "blocked": self.blocked,
            "error": self.error,
        })
    }
}

enum Detail {
    Activity {
        scan_id: Option<String>,
        entries: Vec<String>,
    },
    Cycles(Vec<Value>),
}

struct SnapshotInput {
    lifecycle: String,
    paused: bool,
    enabled: bool,
    owned: bool,
    attached: bool,
    minutes: u32,
    last_run_at: Option<String>,
    next_run_at: Option<String>,
    limits: Limits,
    issues: Vec<Value>,
    documentation: Vec<Value>,
    releases: Vec<Value>,
    pending: u64,
    sync: AgentSync,
    detail: Detail,
    notice: Option<String>,
    error: Option<String>,
    timer: Option<TimerGate>,
    workers: Vec<Worker>,
}

fn nullable_text(value: Option<String>) -> Value {
    match value {
        Some(text) if !text.is_empty() => Value::String(text),
        _ => Value::Null,
    }
}

fn lifecycle_in_vocabulary(value: &str) -> &str {
    if LIFECYCLES.contains(&value) {
        value
    } else {
        "stopped"
    }
}

fn normalize_issue(row: Value) -> Value {
    let object = row.as_object();
    let text = |key: &str| -> Option<String> {
        object
            .and_then(|map| map.get(key))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    let state = text("state").filter(|value| ISSUE_STATES.contains(&value.as_str()));
    json!({
        "title": object.and_then(|map| map.get("title")).cloned().unwrap_or(Value::Null),
        "category": nullable_text(text("category")),
        "filedAt": object.and_then(|map| map.get("filedAt")).cloned().unwrap_or(Value::Null),
        "url": object.and_then(|map| map.get("url")).cloned().unwrap_or(Value::Null),
        "state": state.unwrap_or_else(|| "unknown".to_string()),
        "version": nullable_text(text("version")),
        "note": nullable_text(text("note")),
    })
}

fn normalize_documentation(values: Vec<Value>) -> Vec<Value> {
    values
        .into_iter()
        .filter(|entry| {
            let Some(object) = entry.as_object() else {
                return false;
            };
            let strings = ["at", "version", "url", "summary", "diff"]
                .iter()
                .all(|key| object.get(*key).and_then(Value::as_str).is_some());
            let files = object
                .get("files")
                .and_then(Value::as_array)
                .map(|files| files.iter().all(Value::is_string))
                .unwrap_or(false);
            strings && files
        })
        .take(DOCUMENTATION_HISTORY_LIMIT)
        .collect()
}

fn normalize_release(entry: &Value) -> Option<Value> {
    let object = entry.as_object()?;
    let at = object.get("at").and_then(Value::as_str)?;
    let version = object.get("version").and_then(Value::as_str)?;
    let url = match object.get("url") {
        Some(Value::Null) => Value::Null,
        Some(Value::String(text)) => Value::String(text.clone()),
        _ => return None,
    };
    let commits = match object.get("commits") {
        Some(Value::Null) | None => Value::Null,
        Some(Value::Number(number)) => {
            let value = number.as_u64()?;
            json!(value)
        }
        _ => return None,
    };
    Some(json!({
        "at": at,
        "version": version,
        "url": url,
        "commits": commits,
    }))
}

fn normalize_workers(workers: Vec<Worker>) -> Vec<Value> {
    workers
        .into_iter()
        .filter(|worker| worker.pid > 0)
        .map(|worker| worker.to_json())
        .collect()
}

fn project_snapshot(descriptor: &Descriptor, input: SnapshotInput) -> Value {
    let mut issues: Vec<Value> = input.issues.into_iter().map(normalize_issue).collect();
    issues.sort_by(|left, right| {
        let left_at = left
            .get("filedAt")
            .and_then(Value::as_str)
            .and_then(parse_millis)
            .unwrap_or(0);
        let right_at = right
            .get("filedAt")
            .and_then(Value::as_str)
            .and_then(parse_millis)
            .unwrap_or(0);
        if left_at != right_at {
            return right_at.cmp(&left_at);
        }
        let left_url = left.get("url").and_then(Value::as_str).unwrap_or("");
        let right_url = right.get("url").and_then(Value::as_str).unwrap_or("");
        left_url.cmp(right_url)
    });
    let releases: Vec<Value> = input
        .releases
        .iter()
        .filter_map(normalize_release)
        .take(DOCUMENTATION_HISTORY_LIMIT)
        .collect();
    let detail = match input.detail {
        Detail::Activity { scan_id, entries } => json!({
            "panel": "activity",
            "scanId": scan_id,
            "entries": entries,
        }),
        Detail::Cycles(cycles) => json!({
            "panel": "cycles",
            "cycles": cycles,
        }),
    };
    let minutes = if input.minutes < descriptor.min_minutes {
        descriptor.min_minutes
    } else if input.minutes > descriptor.max_minutes {
        descriptor.max_minutes
    } else {
        input.minutes
    };
    json!({
        "id": descriptor.id,
        "label": descriptor.label,
        "description": descriptor.description,
        "scope": descriptor.scope,
        "lifecycle": lifecycle_in_vocabulary(&input.lifecycle),
        "paused": input.paused,
        "enabled": input.enabled,
        "owned": input.owned,
        "attached": input.attached,
        "cadence": {
            "minutes": minutes,
            "defaultMinutes": descriptor.default_minutes,
            "lastRunAt": input.last_run_at,
            "nextRunAt": input.next_run_at,
        },
        "limits": input.limits.to_json(),
        "issues": issues,
        "documentation": normalize_documentation(input.documentation),
        "pending": input.pending,
        "sync": input.sync.to_json(),
        "detail": detail,
        "releases": releases,
        "notice": nullable_text(input.notice),
        "error": nullable_text(input.error),
        "timer": match input.timer {
            Some(timer) => timer.to_json(),
            None => Value::Null,
        },
        "workers": normalize_workers(input.workers),
    })
}

/* ------------------------------------------------------------------------ */
/* Files                                                                     */
/* ------------------------------------------------------------------------ */

fn read_json(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn read_activity(directory: &Path) -> Vec<String> {
    match read_json(&directory.join("activity.json")) {
        Some(Value::Array(entries)) => entries
            .into_iter()
            .filter_map(|entry| entry.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    }
}

fn worker_version_key(version: Option<&str>) -> String {
    let text = match version {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => "unknown".to_string(),
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

#[cfg(test)]
thread_local! {
    /// State-tree walks this thread performed. A projection answers from one
    /// walk, so a test proves the count without depending on another test's
    /// families, which run on their own threads.
    static STATE_TREE_WALKS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn worker_state_directories(root: &Path) -> Vec<PathBuf> {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(root.join("workers"))
        .map(|directory| {
            directory
                .filter_map(Result::ok)
                .filter(|entry| entry.path().is_dir())
                .map(|entry| entry.path())
                .collect()
        })
        .unwrap_or_default();
    entries.sort();
    entries
}

/// A metadata-only fingerprint of a directory tree: every entry's path, size,
/// modification time, and kind. The poll compares it to the previous tick so
/// an unchanged family is not projected or serialized again. File contents are
/// never read, and a symlink is never followed into a directory.
fn tree_signature(root: &Path) -> u64 {
    use std::hash::{Hash, Hasher};

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut seen = 0usize;
    while let Some((directory, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            seen += 1;
            if seen > 4096 {
                return hasher.finish();
            }
            let path = entry.path();
            path.to_string_lossy().hash(&mut hasher);
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            metadata.len().hash(&mut hasher);
            if let Ok(modified) = metadata.modified() {
                let nanos = modified
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|duration| duration.as_nanos())
                    .unwrap_or(0);
                nanos.hash(&mut hasher);
            }
            let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
            is_dir.hash(&mut hasher);
            if is_dir && depth < 8 {
                stack.push((path, depth + 1));
            }
        }
    }
    hasher.finish()
}

fn resolved(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// The notice a Start publishes when it spawns nothing. It outranks the
/// steady foreign-owner notice so the answer to that Start is visibly a new
/// snapshot, not the one the client already had.
fn is_start_refusal(notice: &str) -> bool {
    notice.starts_with("Start did nothing:")
}

fn canonical_process_path(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn first_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

fn process_environment() -> HashMap<String, String> {
    std::env::vars().collect()
}

fn environment_value(environment: &HashMap<String, String>, key: &str) -> Option<String> {
    environment
        .get(key)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn find_on_path(name: &str, environment: &HashMap<String, String>) -> Option<PathBuf> {
    let path = environment.get("PATH").cloned().unwrap_or_default();
    for directory in path.split(':') {
        if directory.is_empty() {
            continue;
        }
        let candidate = Path::new(directory).join(name);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn inside(root: &Path, candidate: &Path) -> bool {
    let root = resolved(root);
    let candidate = resolved(candidate);
    candidate
        .strip_prefix(&root)
        .map(|relative| !relative.as_os_str().is_empty())
        .unwrap_or(false)
}

fn command_paths(
    repo_dir: &Path,
    environment: &HashMap<String, String>,
    command: &str,
) -> Vec<PathBuf> {
    let home = environment
        .get("HOME")
        .cloned()
        .unwrap_or_else(|| "/root".to_string());
    vec![
        repo_dir
            .join(".omp")
            .join("commands")
            .join(format!("{command}.md")),
        PathBuf::from(&home)
            .join(".omp")
            .join("commands")
            .join(format!("{command}.md")),
        PathBuf::from(&home)
            .join(".omp")
            .join("agent")
            .join("commands")
            .join(format!("{command}.md")),
    ]
}

/* ------------------------------------------------------------------------ */
/* Forge origin                                                              */
/* ------------------------------------------------------------------------ */

#[derive(Clone, Debug)]
struct ForgeRemote {
    forge: String,
    host: String,
    project: String,
    origin_url: Option<String>,
}

fn path_segments(path: &str) -> Vec<String> {
    let trimmed = path.trim_start_matches('/').trim_end_matches('/');
    let trimmed = trimmed
        .strip_suffix(".git")
        .or_else(|| trimmed.strip_suffix(".GIT"))
        .unwrap_or(trimmed);
    trimmed
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(str::to_string)
        .collect()
}

fn project_from_path(path: &str, forge: &str) -> Option<String> {
    let segments = path_segments(path);
    if segments.len() < 2 {
        return None;
    }
    let kept: &[String] = if forge == "gitlab" {
        &segments
    } else {
        &segments[segments.len() - 2..]
    };
    let valid = kept.iter().all(|segment| {
        !segment.is_empty()
            && segment.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
            })
    });
    if !valid {
        return None;
    }
    Some(kept.join("/"))
}

fn instance_prefix(path: &str, forge: &str) -> String {
    let segments = path_segments(path);
    let kept = if forge == "gitlab" { segments.len() } else { 2 };
    if segments.len() <= kept {
        return String::new();
    }
    format!("/{}", segments[..segments.len() - kept].join("/"))
}

fn forge_from_host(host: &str, environment: &HashMap<String, String>) -> String {
    let lower = host.to_lowercase();
    if let Some(forced) = environment_value(environment, "DEVBOARD_FORGE") {
        let forced = forced.to_lowercase();
        if matches!(forced.as_str(), "github" | "gitlab" | "gitea") {
            return forced;
        }
    }
    if lower == "github.com" {
        return "github".to_string();
    }
    if lower.contains("gitlab") {
        return "gitlab".to_string();
    }
    "gitea".to_string()
}

fn parse_forge_remote(remote: &str, environment: &HashMap<String, String>) -> Option<ForgeRemote> {
    let value = remote.trim();
    if value.is_empty() || value.starts_with('/') || value.starts_with('.') {
        return None;
    }
    let mut http_origin: Option<String> = None;
    let scp_like = !value.contains("://")
        && value
            .split_once(':')
            .map(|(left, right)| {
                !left.contains('/') && !left.contains(char::is_whitespace) && !right.is_empty()
            })
            .unwrap_or(false);
    let (host, path) = if scp_like {
        let (left, right) = value.split_once(':')?;
        (
            left.rsplit('@').next().unwrap_or(left).to_string(),
            right.to_string(),
        )
    } else {
        let (scheme, rest) = value.split_once("://")?;
        if !matches!(scheme, "http" | "https" | "ssh" | "git") {
            return None;
        }
        let (authority, pathname) = match rest.split_once('/') {
            Some((authority, pathname)) => (authority, format!("/{pathname}")),
            None => (rest, String::new()),
        };
        let authority = authority.rsplit('@').next().unwrap_or(authority);
        if matches!(scheme, "http" | "https") {
            http_origin = Some(format!("{scheme}://{authority}"));
        }
        (
            authority.split(':').next().unwrap_or(authority).to_string(),
            pathname,
        )
    };
    if host.is_empty() {
        return None;
    }
    let forge = forge_from_host(&host, environment);
    let project = project_from_path(&path, &forge)?;
    Some(ForgeRemote {
        forge: forge.clone(),
        host: host.to_lowercase(),
        project,
        origin_url: http_origin.map(|origin| format!("{origin}{}", instance_prefix(&path, &forge))),
    })
}

fn git_stdout(repo_dir: &Path, args: &[&str]) -> Option<String> {
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
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn origin_remote_url(root: &Path) -> Option<String> {
    git_stdout(root, &["remote", "get-url", "origin"])
}

fn origin_forge(root: &Path, environment: &HashMap<String, String>) -> Option<ForgeRemote> {
    let top = git_stdout(root, &["rev-parse", "--show-toplevel"])?;
    if resolved(Path::new(&top)) != resolved(root) {
        return None;
    }
    parse_forge_remote(&origin_remote_url(root)?, environment)
}

fn gitea_base_url(remote: &ForgeRemote, environment: &HashMap<String, String>) -> Option<String> {
    for key in ["DEVBOARD_GITEA_URL", "GITEA_URL"] {
        if let Some(value) = environment_value(environment, key) {
            return Some(value.trim_end_matches('/').to_string());
        }
    }
    if remote.forge == "gitea" {
        remote.origin_url.clone()
    } else {
        None
    }
}

fn configured_gitea_token(environment: &HashMap<String, String>) -> Option<String> {
    for key in ["GITEA_TOKEN", "DEVBOARD_GITEA_TOKEN"] {
        if let Some(value) = environment_value(environment, key) {
            return Some(value);
        }
    }
    None
}

fn root_problem(root: &Path) -> Option<String> {
    let absolute = resolved(root);
    if !root.exists() {
        return Some(format!("{} does not exist", root.display()));
    }
    let Some(top) = git_stdout(root, &["rev-parse", "--show-toplevel"]) else {
        return Some(format!("{} is not a git checkout", root.display()));
    };
    if resolved(Path::new(&top)) != resolved(root) {
        return Some(format!(
            "{} is not the checkout root ({top} is)",
            root.display()
        ));
    }
    let git_dir = root.join(".git");
    if git_dir.is_file() {
        return Some(format!(
            "{} is a linked git worktree, not the canonical checkout",
            root.display()
        ));
    }
    if !absolute.join(".devboard").exists() {
        return Some(format!("{} has no .devboard directory", absolute.display()));
    }
    None
}

/* ------------------------------------------------------------------------ */
/* Forge projection                                                          */
/* ------------------------------------------------------------------------ */

/// One forge fact a read resolved for one issue URL.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForgeFact {
    pub url: String,
    pub state: String,
    pub version: Option<String>,
}

/// The cached answer for one URL.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForgeAnswer {
    pub state: String,
    pub version: Option<String>,
}

/// One batch read: receives the URLs that still need an answer.
pub type ForgeReadFuture = Pin<Box<dyn Future<Output = Result<Vec<ForgeFact>, String>> + Send>>;
pub type ForgeReader = Arc<dyn Fn(Vec<String>) -> ForgeReadFuture + Send + Sync>;

struct ForgeInner {
    facts: HashMap<String, ForgeAnswer>,
    asked: Option<HashSet<String>>,
    answered: HashSet<String>,
    unreadable: HashSet<String>,
    last_started_at: Option<i64>,
    last_success: Option<i64>,
    last_failure: Option<String>,
    next_attempt_at: Option<i64>,
    retry: crate::forge::ForgeReadRetry,
    reading: bool,
}

/// The per-family cache of resolved forge facts.
pub struct ForgeProjection {
    inner: Mutex<ForgeInner>,
    reader: Option<ForgeReader>,
    interval_ms: i64,
    stale_after_ms: i64,
}

impl ForgeProjection {
    pub fn new(reader: Option<ForgeReader>, seed: Vec<ForgeFact>) -> Self {
        let mut inner = ForgeInner {
            facts: HashMap::new(),
            asked: None,
            answered: HashSet::new(),
            unreadable: HashSet::new(),
            last_started_at: None,
            last_success: None,
            last_failure: None,
            next_attempt_at: None,
            retry: crate::forge::ForgeReadRetry::new(),
            reading: false,
        };
        for fact in seed {
            if fact.state == "unreadable" {
                inner.unreadable.insert(fact.url);
            } else {
                inner.facts.insert(
                    fact.url,
                    ForgeAnswer {
                        state: fact.state,
                        version: fact.version,
                    },
                );
            }
        }
        Self {
            inner: Mutex::new(inner),
            reader,
            interval_ms: AGENT_FORGE_INTERVAL_MS,
            stale_after_ms: AGENT_FORGE_STALE_MS,
        }
    }

    pub fn fact(&self, url: &str) -> Option<ForgeAnswer> {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| inner.facts.get(url).cloned())
    }

    fn unreadable(&self, url: &str) -> bool {
        self.inner
            .lock()
            .map(|inner| inner.unreadable.contains(url))
            .unwrap_or(false)
    }

    fn reported(&self, url: &str) -> bool {
        self.inner
            .lock()
            .map(|inner| {
                let Some(asked) = inner.asked.as_ref() else {
                    return true;
                };
                !asked.contains(url)
                    || inner.answered.contains(url)
                    || inner.unreadable.contains(url)
            })
            .unwrap_or(true)
    }

    fn sync(&self, now: i64) -> AgentSync {
        let Ok(inner) = self.inner.lock() else {
            return AgentSync::stale();
        };
        let at = inner.last_success.map(iso_from_millis);
        if let Some(error) = inner.last_failure.clone() {
            return AgentSync {
                state: "error".to_string(),
                at,
                error: Some(error),
            };
        }
        if inner.retry.failures() > 0 {
            return AgentSync {
                state: "stale".to_string(),
                at,
                error: None,
            };
        }
        let Some(last_success) = inner.last_success else {
            return AgentSync::stale();
        };
        // A known row goes stale once the staleness interval passes without a
        // successful read; a fresh successful read is the only `ok`.
        if now.saturating_sub(last_success) > self.stale_after_ms {
            return AgentSync {
                state: "stale".to_string(),
                at,
                error: None,
            };
        }
        AgentSync {
            state: "ok".to_string(),
            at,
            error: None,
        }
    }

    /// A view opened this table: the sub-second poll schedules the read.
    fn request_sync_only(&self) {}

    /// An empty table needs no forge round trip: the read answers immediately,
    /// exactly as `urls.length === 0 ? [] : reader.project(urls)` does.
    fn note_empty_read(&self, now: i64) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        // The read already answered for an empty table; a later snapshot is not
        // a new read, so its bytes (and the sync instant) stay unchanged.
        if inner.last_success.is_some()
            && inner.facts.is_empty()
            && inner.asked.as_ref().map(HashSet::is_empty).unwrap_or(false)
        {
            return;
        }
        inner.facts.clear();
        inner.asked = Some(HashSet::new());
        inner.answered.clear();
        inner.unreadable.clear();
        inner.last_success = Some(now);
        inner.last_failure = None;
        inner.next_attempt_at = None;
        inner.retry.succeed();
        inner.reading = false;
    }

    /// Whether a read is due; repeated requests inside one interval start none.
    fn due(&self, now: i64, has_clients: bool) -> bool {
        if !has_clients {
            return false;
        }
        let Ok(mut inner) = self.inner.lock() else {
            return false;
        };
        if inner.reading || self.reader.is_none() {
            return false;
        }
        if let Some(last) = inner.last_started_at {
            let due = inner.next_attempt_at.unwrap_or(last + self.interval_ms);
            if now < due {
                return false;
            }
        }
        inner.reading = true;
        inner.last_started_at = Some(now);
        inner.next_attempt_at = None;
        true
    }

    /// The URLs this cycle must read: pending answers and unreadable URLs.
    /// A resolved fact is cached and never requested again.
    pub fn pending_urls(&self, urls: Vec<String>) -> Vec<String> {
        let Ok(inner) = self.inner.lock() else {
            return urls;
        };
        urls.into_iter()
            .filter(|url| {
                inner.unreadable.contains(url)
                    || inner
                        .facts
                        .get(url)
                        .map(|answer| answer.state != "implemented")
                        .unwrap_or(true)
            })
            .collect()
    }

    pub fn apply(&self, urls: Vec<String>, facts: Vec<ForgeFact>, now: i64) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        // Keep every resolved answer the read did not ask about. Only the
        // URLs of this cycle are replaced by what the read returned.
        let asked: HashSet<String> = urls.iter().cloned().collect();
        let mut next: HashMap<String, ForgeAnswer> = inner
            .facts
            .iter()
            .filter(|(url, _)| !asked.contains(*url))
            .map(|(url, answer)| (url.clone(), answer.clone()))
            .collect();
        let mut unreadable: HashSet<String> = inner
            .unreadable
            .iter()
            .filter(|url| !asked.contains(*url))
            .cloned()
            .collect();
        for fact in facts {
            if fact.state == "unreadable" {
                unreadable.insert(fact.url);
                continue;
            }
            next.insert(
                fact.url,
                ForgeAnswer {
                    state: if fact.state == "implemented" {
                        "implemented".to_string()
                    } else {
                        "pending".to_string()
                    },
                    version: if fact.state == "implemented" {
                        fact.version
                    } else {
                        None
                    },
                },
            );
        }
        inner.asked = Some(asked);
        inner.answered = next.keys().cloned().collect();
        inner.facts = next;
        inner.unreadable = unreadable;
        inner.last_success = Some(now);
        inner.last_failure = None;
        inner.next_attempt_at = None;
        inner.retry.succeed();
        inner.reading = false;
    }

    fn fail(&self, detail: String, now: i64) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        inner.reading = false;
        let reason = first_line(&detail).unwrap_or_else(|| "no diagnostic".to_string());
        let kind = crate::forge::classify_forge_read_failure(&detail);
        let delay = inner.retry.record(kind);
        match delay {
            // A transient failure below the cap is a retry window, not an
            // alert: the last rows and read time stay.
            Some(delay) if kind == crate::forge::ForgeReadFailureKind::Transient => {
                inner.last_failure = None;
                inner.next_attempt_at = Some(now + delay as i64);
            }
            _ => {
                inner.last_failure = Some(reason);
                inner.next_attempt_at = None;
            }
        }
    }
}

/* ------------------------------------------------------------------------ */
/* Live forge reader                                                         */
/* ------------------------------------------------------------------------ */

fn live_forge_reader(repo_dir: PathBuf, environment: HashMap<String, String>) -> ForgeReader {
    Arc::new(move |urls: Vec<String>| {
        let repo_dir = repo_dir.clone();
        let environment = environment.clone();
        Box::pin(async move {
            let remote =
                crate::forge::origin_forge_with(&repo_dir, &environment).ok_or_else(|| {
                    "the checkout's origin does not name a supported repository".to_string()
                })?;
            match remote.forge {
                crate::forge::Forge::GitHub => {
                    let runner = github_runner(environment.clone());
                    let mut clients: HashMap<String, crate::forge::RepositoryGitHub> = HashMap::new();
                    let mut releases: HashMap<String, Vec<crate::forge::GitHubRelease>> = HashMap::new();
                    let mut facts = Vec::new();
                    for url in urls {
                        let Some(number) = crate::forge::issue_number_from_url(&url) else {
                            return Err(format!("not a GitHub issue URL: {url}"));
                        };
                        let Some(repository) = crate::forge::repository_from_url(&url, &environment) else {
                            return Err(format!("not a GitHub issue URL: {url}"));
                        };
                        if !clients.contains_key(&repository) {
                            clients.insert(
                                repository.clone(),
                                crate::forge::RepositoryGitHub::new(
                                    crate::forge::RepositoryGitHubOptions {
                                        repository: repository.clone(),
                                        repo_dir: repo_dir.clone(),
                                        run: Arc::clone(&runner),
                                        environment: environment.clone(),
                                    },
                                ),
                            );
                        }
                        let client = clients.get(&repository).expect("a GitHub client");
                        let times = client
                            .issue_times(number)
                            .await
                            .map_err(|detail| detail.to_string())?;
                        if times.state == crate::forge::IssueState::Open {
                            facts.push(ForgeFact {
                                url,
                                state: "pending".to_string(),
                                version: None,
                            });
                            continue;
                        }
                        if !releases.contains_key(&repository) {
                            let listed = client
                                .list_releases()
                                .await
                                .map_err(|detail| detail.to_string())?;
                            releases.insert(repository.clone(), listed);
                        }
                        let published = releases.get(&repository).cloned().unwrap_or_default();
                        let issue = crate::forge::ClosingCommitIssue {
                            number,
                            state: crate::forge::IssueState::Closed,
                            created_at: times.created_at,
                            closed_at: times.closed_at,
                        };
                        let resolution = crate::forge::resolve_shipped_version(
                            &issue,
                            client,
                            &published,
                        )
                        .await;
                        facts.push(ForgeFact {
                            url,
                            state: "implemented".to_string(),
                            version: resolution.version,
                        });
                    }
                    Ok(facts)
                }
                crate::forge::Forge::Gitea => {
                    let gitea_origin = crate::forge::gitea_base_url(Some(&remote), &environment);
                    let target = crate::forge::gitea_target(
                        Some(&remote),
                        None,
                        None,
                        None,
                        &environment,
                    )
                    .map_err(|error| error.to_string())?;
                    let transport = crate::forge::default_transport(20_000);
                    let options = crate::forge::GiteaCallOptions { flow_id: None, timeout_ms: None };
                    let mut releases: Option<Vec<crate::forge::GitHubRelease>> = None;
                    let mut facts = Vec::new();
                    for url in urls {
                        let Some(number) = crate::forge::issue_number_from_url(&url) else {
                            return Err(format!("not a supported issue URL: {url}"));
                        };
                        let host = |value: &str| {
                            value
                                .split("://")
                                .nth(1)
                                .and_then(|rest| rest.split('/').next())
                                .map(str::to_lowercase)
                        };
                        let served = gitea_origin
                            .as_deref()
                            .map(|base| host(base) == host(&url) && url.contains(&format!("/{}/issues/{number}", target.project)))
                            .unwrap_or(false);
                        if !served {
                            facts.push(ForgeFact {
                                url,
                                state: "unreadable".to_string(),
                                version: None,
                            });
                            continue;
                        }
                        let path = format!(
                            "{}/issues/{number}",
                            crate::forge::repo_path(&target)
                        );
                        let document = match crate::forge::gitea_json(
                            &target, &path, None, &transport, &options,
                        )
                        .await
                        {
                            Ok(document) => document,
                            Err(error) => return Err(error.to_string()),
                        };
                        if document.get("state").and_then(Value::as_str) != Some("closed") {
                            facts.push(ForgeFact {
                                url,
                                state: "pending".to_string(),
                                version: None,
                            });
                            continue;
                        }
                        if releases.is_none() {
                            let listed = crate::forge::gitea_list_releases(
                                &target, &transport, &options,
                            )
                            .await
                            .map_err(|error| error.to_string())?
                            .into_iter()
                            .map(|release| crate::forge::GitHubRelease {
                                tag: release.tag,
                                published_at: release.published_at,
                            })
                            .collect();
                            releases = Some(listed);
                        }
                        let closing = crate::forge::gitea_closing_commits(
                            &target, number, &transport, &options,
                        )
                        .await
                        .map_err(|error| error.to_string())?;
                        let client = GiteaCommitClient {
                            repo_dir: repo_dir.clone(),
                            closing,
                        };
                        let issue = crate::forge::ClosingCommitIssue {
                            number,
                            state: crate::forge::IssueState::Closed,
                            created_at: document
                                .get("created_at")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                            closed_at: document
                                .get("closed_at")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                        };
                        let resolution = crate::forge::resolve_shipped_version(
                            &issue,
                            &client,
                            releases.as_deref().unwrap_or_default(),
                        )
                        .await;
                        facts.push(ForgeFact {
                            url,
                            state: "implemented".to_string(),
                            version: resolution.version,
                        });
                    }
                    Ok(facts)
                }
                crate::forge::Forge::GitLab => Err(
                    "the agent activity reads GitHub and Gitea origins; a GitLab origin is not supported"
                        .to_string(),
                ),
            }
        })
    })
}

fn github_runner(environment: HashMap<String, String>) -> crate::forge::GitHubCommandRunner {
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
            let wait = child.wait_with_output();
            match tokio::time::timeout(Duration::from_millis(20_000), wait).await {
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

struct GiteaCommitClient {
    repo_dir: PathBuf,
    closing: Vec<String>,
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
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

impl crate::forge::ClosingCommitClient for GiteaCommitClient {
    fn closing_commit(&self, _issue_number: i64) -> crate::forge::ClientFuture<'_, Option<String>> {
        let first = self.closing.first().cloned();
        Box::pin(async move { Ok(first) })
    }

    fn closing_commits(&self, _issue_number: i64) -> crate::forge::ClientFuture<'_, Vec<String>> {
        let closing = self.closing.clone();
        Box::pin(async move { Ok(closing) })
    }

    fn landed_commits(&self, issue_number: i64) -> Vec<String> {
        git_line(
            &self.repo_dir,
            &[
                "log",
                "--all",
                "--format=%H",
                &format!("--grep=(#{issue_number})"),
            ],
        )
        .map(|text| text.lines().map(str::to_string).collect())
        .unwrap_or_default()
    }

    fn resolve_commit(&self, short: String) -> crate::forge::ClientFuture<'_, Option<String>> {
        let repo_dir = self.repo_dir.clone();
        Box::pin(async move {
            Ok(git_line(
                &repo_dir,
                &["rev-parse", "--verify", &format!("{short}^{{commit}}")],
            ))
        })
    }

    fn containing_release_tags(
        &self,
        commit: String,
        _releases: Vec<crate::forge::GitHubRelease>,
    ) -> crate::forge::ClientFuture<'_, Vec<String>> {
        let repo_dir = self.repo_dir.clone();
        Box::pin(async move {
            Ok(git_line(&repo_dir, &["tag", "--contains", &commit])
                .map(|text| text.lines().map(str::to_string).collect())
                .unwrap_or_default())
        })
    }
}

/* ------------------------------------------------------------------------ */
/* Prompt documents                                                          */
/* ------------------------------------------------------------------------ */

struct PromptController {
    repo_dir: PathBuf,
    state_dir: PathBuf,
    /// The latest fresh open-issue read, shared by every generated template.
    open_issues: Arc<Mutex<Option<Vec<Value>>>>,
}

impl PromptController {
    fn snapshot(&self, id: &str) -> Option<Value> {
        let descriptor = descriptor(id)?;
        match descriptor.prompt {
            PromptKind::Absent => Some(json!({
                "id": id,
                "absent": true,
                "text": null,
                "error": null,
            })),
            PromptKind::Template(message) => {
                let (template, error) = match self.template(id) {
                    Ok(text) => (Some(text), None),
                    Err(detail) => (
                        None,
                        Some(format!(
                            "Could not build the {} prompt template: {detail}",
                            descriptor.label
                        )),
                    ),
                };
                let error = if template.is_none() && error.is_none() {
                    Some(format!(
                        "{} has no generated prompt template.",
                        descriptor.label
                    ))
                } else {
                    error
                };
                let _ = message;
                Some(json!({
                    "id": id,
                    "absent": false,
                    "text": null,
                    "error": error,
                    "template": template,
                }))
            }
            PromptKind::File(file) => {
                let path = self.repo_dir.join(".devboard").join("prompts").join(file);
                match std::fs::read_to_string(&path) {
                    Ok(text) => Some(json!({
                        "id": id,
                        "absent": false,
                        "text": text,
                        "error": null,
                    })),
                    Err(error) => Some(json!({
                        "id": id,
                        "absent": false,
                        "text": null,
                        "error": format!(
                            "Could not read the {} prompt at {}: {}",
                            descriptor.label,
                            path.display(),
                            node_error(&error, &path),
                        ),
                    })),
                }
            }
        }
    }

    fn template(&self, id: &str) -> Result<String, String> {
        if id != "mcp-optimizer" {
            return Err(format!("there is no template for {id}"));
        }
        let directory = crate::agents_mode::mcp_optimizer_directory(&self.state_dir);
        let settings = read_mcp_settings(&directory);
        let open_issues = self
            .open_issues
            .lock()
            .ok()
            .and_then(|issues| issues.clone());
        Ok(mcp_optimizer_prompt_template(
            &settings,
            open_issues.as_deref(),
        ))
    }

    /// Republishes every generated template after a read its text depends on
    /// changed. It sends the same frame a connect sends and touches nothing
    /// else.
    fn publish_templates(&self, shared: &Shared) {
        for descriptor in DESCRIPTORS.iter() {
            if !matches!(descriptor.prompt, PromptKind::Template(_)) {
                continue;
            }
            if let Some(prompt) = self.snapshot(descriptor.id) {
                shared.send_all(
                    json!({
                        "type": "agentPromptState",
                        "id": descriptor.id,
                        "prompt": prompt,
                    }),
                    None,
                );
            }
        }
    }

    fn replay(&self, conn: &Conn) {
        for descriptor in DESCRIPTORS.iter() {
            if let Some(prompt) = self.snapshot(descriptor.id) {
                conn.send(json!({
                    "type": "agentPromptState",
                    "id": descriptor.id,
                    "prompt": prompt,
                }));
            }
        }
    }

    fn replay_one(&self, conn: &Conn, id: &str) {
        match self.snapshot(id) {
            Some(prompt) => conn.send(json!({
                "type": "agentPromptState",
                "id": id,
                "prompt": prompt,
            })),
            None => conn.send(json!({
                "type": "agentPromptError",
                "id": id,
                "message": format!("Unknown background agent: {id}."),
            })),
        }
    }
}

fn node_error(error: &std::io::Error, path: &Path) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        format!(
            "ENOENT: no such file or directory, open '{}'",
            path.display()
        )
    } else {
        error.to_string()
    }
}

/* ------------------------------------------------------------------------ */
/* MCP optimizer prompt template                                             */
/* ------------------------------------------------------------------------ */

fn json_pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}

fn mcp_catalog_json() -> String {
    let payload = crate::mcp::tool_list_payload();
    let tools = payload
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let rows: Vec<Value> = tools
        .iter()
        .filter_map(|tool| {
            Some(json!({
                "name": tool.get("name")?.as_str()?,
                "title": tool.get("title")?.as_str()?,
            }))
        })
        .collect();
    let mut covers: Vec<String> = tools
        .iter()
        .filter_map(|tool| tool.get("covers").and_then(Value::as_array))
        .flat_map(|entries| entries.iter().filter_map(Value::as_str).map(str::to_string))
        .collect();
    covers.sort();
    covers.dedup();
    json_pretty(&json!({ "tools": rows, "covers": covers }))
}

struct PromptSections {
    family: String,
    fragments: String,
    excerpts: String,
    catalog: String,
    issues: String,
    allowlist: String,
    limits: String,
}

fn prompt_text(sections: PromptSections) -> String {
    [
        "## Manifesto",
        "",
        "You are the Devboard MCP optimizer synthesizer for one family. Your goal is to remove the",
        "recurring friction this family evidences, and your observable result is at most one proposal",
        "issue filed through the Devboard MCP issue tool, or one recorded reason the family needs no",
        "issue.",
        "",
        "Read this family's evidence, read the open MCP optimizer issues yourself, then act. Never",
        "answer with a JSON document, fragment, diff, or summary.",
        "",
        "Family:",
        &sections.family,
        "",
        "Fragments:",
        &sections.fragments,
        "",
        "Excerpts:",
        &sections.excerpts,
        "",
        "MCP catalog:",
        &sections.catalog,
        "",
        "Open MCP optimizer issues:",
        &sections.issues,
        "",
        "Command allowlist:",
        &sections.allowlist,
        "",
        "Limits:",
        &sections.limits,
        "",
        "Rules:",
        "- Read the open issues with `issues_list` and `issue_get`. A proposal duplicates an open",
        "  issue when that issue carries this family's tag or the same title. A duplicate files and",
        "  comments on nothing.",
        "- File at most one issue for this family, and only when `filingRoom` is greater than zero.",
        "- Prefer the smaller change: \"tool\" when a stable named capability removes the recurrence,",
        "  \"prompt\" when one instruction is enough.",
        "- A tool proposal names a capability, not a wrapper around this one command. Never reuse a",
        "  name from the catalog. `covers` entries are the normalized command prefixes the tool",
        "  replaces; at least one must match the family key. The family must be covered by the",
        "  command allowlist; the body carries the exact allowlist entry to add.",
        "- A prompt proposal names one instruction and a target under `.devboard/prompts/` or an",
        "  agent id.",
        "- The issue title is exactly `[mcp-optimizer] <family key>` for a tool proposal or",
        "  `[mcp-optimizer] prompt: <family key>` for a prompt proposal.",
        "- The issue body has exactly these level-two sections in order: `## Family`,",
        "  `## Evidence`, `## Proposed tool` or `## Proposed prompt`, `## Acceptance`, `## Rationale`.",
        "  `## Family` states the key, kind, call and session counts, first and last timestamps,",
        "  and the family tag. `## Evidence` carries the fragments and the excerpts. `## Acceptance`",
        "  carries one to five `- [ ]` criteria checkable from the evidence.",
        "- File with `issue_create` and no labels. Its returned number and URL are the record.",
        "- When the family needs no change, a duplicate exists, a cap leaves no room, or filing",
        "  fails, call `mcp_optimizer_proposal_skip` with the family key and one reason sentence.",
        "  Call either `issue_create` or `mcp_optimizer_proposal_skip` for this family, never both.",
        "",
    ]
    .join("\n")
}

fn mcp_optimizer_prompt_template(settings: &McpSettings, open_issues: Option<&[Value]>) -> String {
    let issues = match open_issues {
        None => "Open MCP optimizer issues could not be read.".to_string(),
        Some(issues) => {
            let mut rows: Vec<Value> = issues
                .iter()
                .filter_map(|issue| {
                    let object = issue.as_object()?;
                    let title = object.get("title")?.as_str()?;
                    let body = object.get("body").and_then(Value::as_str).unwrap_or("");
                    if !title.starts_with("[mcp-optimizer]") && !body.contains("family:") {
                        return None;
                    }
                    Some(json!({
                        "number": object.get("number")?.clone(),
                        "title": title,
                        "url": object.get("url")?.clone(),
                    }))
                })
                .collect();
            rows.sort_by(|left, right| {
                let left = left.get("number").and_then(Value::as_u64).unwrap_or(0);
                let right = right.get("number").and_then(Value::as_u64).unwrap_or(0);
                left.cmp(&right)
            });
            json_pretty(&Value::Array(rows))
        }
    };
    prompt_text(PromptSections {
        family: "<family>".to_string(),
        fragments: "<fragments>".to_string(),
        excerpts: "<excerpts>".to_string(),
        catalog: mcp_catalog_json(),
        issues,
        allowlist: json_pretty(&json!(settings.allowlist)),
        limits: json_pretty(&json!({
            "maxIssuesPerCycle": settings.max_issues_per_cycle,
            "maxPerHour": settings.max_per_hour,
            "maxPending": settings.max_pending,
            "filingRoom": "<filingRoom>",
        })),
    })
}

/* ------------------------------------------------------------------------ */
/* Locks                                                                     */
/* ------------------------------------------------------------------------ */

#[derive(Clone, Debug)]
struct LockOwner {
    pid: u32,
    started_at: String,
    state_dir: String,
    harness_version: Option<String>,
}

fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    unsafe {
        if libc::kill(pid as i32, 0) == 0 {
            return true;
        }
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn process_started_at(pid: u32) -> Option<i64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let close = stat.rfind(')')?;
    let suffix: Vec<&str> = stat[close + 2..].split(' ').collect();
    let start_ticks: f64 = suffix.get(19)?.parse().ok()?;
    let uptime_text = std::fs::read_to_string("/proc/uptime").ok()?;
    let uptime_seconds: f64 = uptime_text.split(' ').next()?.parse().ok()?;
    Some(now_millis() - (uptime_seconds * 1000.0) as i64 + (start_ticks * 1000.0 / 100.0) as i64)
}

fn owner_alive(owner: &LockOwner) -> bool {
    if !pid_alive(owner.pid) {
        return false;
    }
    let Some(recorded) = parse_millis(&owner.started_at) else {
        return false;
    };
    match process_started_at(owner.pid) {
        Some(actual) => (actual - recorded).abs() <= 2_000,
        None => true,
    }
}

fn parse_lock(text: &str) -> Option<LockOwner> {
    let value: Value = serde_json::from_str(text).ok()?;
    let object = value.as_object()?;
    let pid = object.get("pid")?.as_u64()? as u32;
    let started_at = object.get("startedAt")?.as_str()?.to_string();
    Some(LockOwner {
        pid,
        started_at,
        state_dir: object
            .get("stateDir")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        harness_version: object
            .get("harnessVersion")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn read_lock(path: &Path) -> Option<LockOwner> {
    parse_lock(&std::fs::read_to_string(path).ok()?)
}

fn live_lock_owner(path: &Path) -> Option<LockOwner> {
    let owner = read_lock(path)?;
    if owner_alive(&owner) {
        Some(owner)
    } else {
        None
    }
}

fn live_lock_owners(path: &Path) -> Vec<LockOwner> {
    let mut owners = Vec::new();
    if let Some(owner) = live_lock_owner(path) {
        owners.push(owner);
    }
    let Some(directory) = path.parent() else {
        return owners;
    };
    let base = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let prefix = format!("{base}.");
    let mut names: Vec<String> = std::fs::read_dir(directory)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    for name in names {
        if !name.starts_with(&prefix) || name.contains(".reclaim-") || name.contains(".new-") {
            continue;
        }
        if let Some(owner) = live_lock_owner(&directory.join(name)) {
            owners.push(owner);
        }
    }
    owners
}

/* ------------------------------------------------------------------------ */
/* Control channel                                                           */
/* ------------------------------------------------------------------------ */

fn write_command(directory: &Path, command: &Value) -> Result<(), std::io::Error> {
    std::fs::create_dir_all(directory)?;
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1;
    let name = format!("{:014}-{:06}.json", now_millis(), sequence);
    let path = directory.join(name);
    let temporary = path.with_file_name(format!(
        "{}.{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    let text = format!("{}\n", serde_json::to_string(command).unwrap_or_default());
    std::fs::write(&temporary, text)?;
    std::fs::rename(&temporary, &path)
}

/* ------------------------------------------------------------------------ */
/* Settings                                                                  */
/* ------------------------------------------------------------------------ */

#[derive(Clone, Debug)]
struct BasicSettings {
    interval_minutes: u32,
    max_per_hour: Option<u32>,
    max_pending: Option<u32>,
}

impl BasicSettings {
    fn to_json(&self) -> Value {
        json!({
            "maxPerHour": self.max_per_hour,
            "maxPending": self.max_pending,
            "intervalMinutes": self.interval_minutes,
        })
    }

    fn to_json_interval_first(&self) -> Value {
        json!({
            "intervalMinutes": self.interval_minutes,
            "maxPerHour": self.max_per_hour,
            "maxPending": self.max_pending,
        })
    }
}

fn valid_limit(value: Option<&Value>) -> Option<Option<u32>> {
    match value {
        Some(Value::Null) => Some(None),
        Some(Value::Number(number)) => number
            .as_u64()
            .filter(|value| (1..=100).contains(value))
            .map(|value| Some(value as u32)),
        _ => None,
    }
}

fn valid_cadence(value: Option<&Value>) -> Option<u32> {
    value
        .and_then(Value::as_u64)
        .filter(|value| (1..=1440).contains(value))
        .map(|value| value as u32)
}

fn parse_basic_settings(text: &str) -> Option<BasicSettings> {
    let value: Value = serde_json::from_str(text).ok()?;
    let object = value.as_object()?;
    let max_per_hour = valid_limit(object.get("maxPerHour"))?;
    let max_pending = valid_limit(object.get("maxPending"))?;
    let interval_minutes = match object.get("intervalMinutes") {
        None => 60,
        Some(value) => valid_cadence(Some(value))?,
    };
    Some(BasicSettings {
        interval_minutes,
        max_per_hour,
        max_pending,
    })
}

fn read_basic_settings(path: &Path) -> Option<BasicSettings> {
    parse_basic_settings(&std::fs::read_to_string(path).ok()?)
}

/* ------------------------------------------------------------------------ */
/* MCP optimizer settings                                                    */
/* ------------------------------------------------------------------------ */

#[derive(Clone, Debug)]
struct McpSettings {
    interval_minutes: u32,
    max_per_hour: Option<u32>,
    max_pending: Option<u32>,
    max_issues_per_cycle: u32,
    allowlist: Vec<String>,
}

impl McpSettings {
    fn defaults() -> Self {
        Self {
            interval_minutes: 60,
            max_per_hour: Some(10),
            max_pending: Some(20),
            max_issues_per_cycle: 2,
            allowlist: Vec::new(),
        }
    }

    fn to_json(&self) -> Value {
        json!({
            "intervalMinutes": self.interval_minutes,
            "maxPerHour": self.max_per_hour,
            "maxPending": self.max_pending,
            "maxIssuesPerCycle": self.max_issues_per_cycle,
            "allowlist": self.allowlist,
        })
    }
}

fn valid_allowlist(value: Option<&Value>) -> Option<Vec<String>> {
    let entries = value?.as_array()?;
    if entries.len() > 50 {
        return None;
    }
    let mut result = Vec::new();
    for entry in entries {
        let text = entry.as_str()?;
        if text.trim().is_empty() || text.len() > 200 {
            return None;
        }
        result.push(text.to_string());
    }
    Some(result)
}

fn parse_mcp_settings(text: &str) -> Option<McpSettings> {
    let value: Value = serde_json::from_str(text).ok()?;
    let object = value.as_object()?;
    let defaults = McpSettings::defaults();
    Some(McpSettings {
        interval_minutes: valid_cadence(object.get("intervalMinutes"))
            .unwrap_or(defaults.interval_minutes),
        max_per_hour: match object.get("maxPerHour") {
            Some(value) => valid_limit(Some(value)).unwrap_or(defaults.max_per_hour),
            None => defaults.max_per_hour,
        },
        max_pending: match object.get("maxPending") {
            Some(value) => valid_limit(Some(value)).unwrap_or(defaults.max_pending),
            None => defaults.max_pending,
        },
        max_issues_per_cycle: object
            .get("maxIssuesPerCycle")
            .and_then(Value::as_u64)
            .filter(|value| (1..=20).contains(value))
            .map(|value| value as u32)
            .unwrap_or(defaults.max_issues_per_cycle),
        allowlist: valid_allowlist(object.get("allowlist")).unwrap_or_default(),
    })
}

fn read_mcp_settings(directory: &Path) -> McpSettings {
    parse_mcp_settings(
        &std::fs::read_to_string(directory.join("settings.json")).unwrap_or_default(),
    )
    .unwrap_or_else(McpSettings::defaults)
}

/* ------------------------------------------------------------------------ */
/* The mode                                                                  */
/* ------------------------------------------------------------------------ */

struct AgentsMode {
    shared: Arc<Shared>,
    prompts: PromptController,
    adapters: Vec<Adapter>,
    signatures: Mutex<HashMap<&'static str, String>>,
    /// The last projected snapshot of each family. The poll replaces it when
    /// the family changes, and a connect replay, `getAgents`, and the page
    /// open's `refreshAgent` answer from it instead of walking a family's state
    /// on a read's critical path. `getAgent` still projects fresh: it is the
    /// proof read a Start's published lock answers.
    cached: Mutex<HashMap<&'static str, Value>>,
    /// The cheap state signature each family's last snapshot was built from.
    /// The 250 ms poll rebuilds and serializes a family only after this
    /// changes, so an idle dashboard does no projection work at all.
    poll_signatures: Mutex<HashMap<&'static str, u64>>,
    /// Broadcasts wait out the connect replay's settle window.
    settle_until: Mutex<i64>,
    has_clients: Arc<dyn Fn() -> bool + Send + Sync>,
}

enum Adapter {
    Repo(RepoFamily),
    Watchdog(WatchdogFamily),
    Mcp(McpFamily),
    Release(ReleaseFamily),
}

impl Adapter {
    fn id(&self) -> &'static str {
        match self {
            Adapter::Repo(family) => family.descriptor.id,
            Adapter::Watchdog(family) => family.descriptor.id,
            Adapter::Mcp(family) => family.descriptor.id,
            Adapter::Release(family) => family.descriptor.id,
        }
    }

    fn descriptor(&self) -> &'static Descriptor {
        match self {
            Adapter::Repo(family) => family.descriptor,
            Adapter::Watchdog(family) => family.descriptor,
            Adapter::Mcp(family) => family.descriptor,
            Adapter::Release(family) => family.descriptor,
        }
    }

    fn snapshot(&self) -> Value {
        match self {
            Adapter::Repo(family) => family.snapshot(),
            Adapter::Watchdog(family) => family.snapshot(),
            Adapter::Mcp(family) => family.snapshot(),
            Adapter::Release(family) => family.snapshot(),
        }
    }

    fn replay(&self, conn: &Conn, shared: &Shared, snapshot: Value) {
        match self {
            Adapter::Repo(family) => family.replay(conn, shared, snapshot),
            Adapter::Watchdog(_) | Adapter::Mcp(_) | Adapter::Release(_) => {}
        }
    }

    async fn takeover(&self) {
        match self {
            Adapter::Repo(family) => family.takeover().await,
            Adapter::Watchdog(family) => family.takeover().await,
            Adapter::Mcp(family) => family.takeover().await,
            Adapter::Release(family) => {
                let _ = family.takeover().await;
            }
        }
    }

    fn preview_start(&self) {
        match self {
            Adapter::Repo(family) => family.preview_start(),
            Adapter::Watchdog(family) => family.preview_start(),
            Adapter::Mcp(family) => family.preview_start(),
            Adapter::Release(family) => family.preview_start(),
        }
    }

    fn clear_preview(&self) {
        match self {
            Adapter::Repo(family) => family.clear_preview(),
            Adapter::Watchdog(family) => family.clear_preview(),
            Adapter::Mcp(family) => family.clear_preview(),
            Adapter::Release(family) => family.clear_preview(),
        }
    }

    fn preflight_cell(&self) -> Option<&SharedPreflight> {
        match self {
            Adapter::Repo(family) => Some(&family.preflight_override),
            Adapter::Watchdog(family) => Some(&family.preflight_override),
            Adapter::Mcp(family) => Some(&family.preflight_override),
            Adapter::Release(_) => None,
        }
    }

    fn preflight_timeout_cell(&self) -> Option<Arc<AtomicU64>> {
        match self {
            Adapter::Repo(family) => Some(family.preflight_timeout_cell()),
            Adapter::Watchdog(family) => Some(family.preflight_timeout_cell()),
            Adapter::Mcp(family) => Some(family.preflight_timeout_cell()),
            Adapter::Release(_) => None,
        }
    }

    fn request_sync(&self) {
        match self {
            Adapter::Repo(family) => family.request_sync(),
            Adapter::Watchdog(family) => family.forge.request_sync_only(),
            Adapter::Mcp(family) => family.forge.request_sync_only(),
            Adapter::Release(family) => family.request_sync(),
        }
    }

    async fn start(&self) -> AgentResult {
        match self {
            Adapter::Repo(family) => family.start().await,
            Adapter::Watchdog(family) => family.start().await,
            Adapter::Mcp(family) => family.start().await,
            Adapter::Release(family) => family.start().await,
        }
    }

    fn stop(&self) -> AgentResult {
        match self {
            Adapter::Repo(family) => family.stop(),
            Adapter::Watchdog(family) => family.stop(),
            Adapter::Mcp(family) => family.stop(),
            Adapter::Release(family) => family.stop(),
        }
    }

    fn set_settings(
        &self,
        minutes: Option<u64>,
        max_per_hour: Option<Value>,
        max_pending: Option<Value>,
    ) -> AgentResult {
        match self {
            Adapter::Repo(family) => family.set_settings(minutes, max_per_hour, max_pending),
            Adapter::Watchdog(family) => family.set_settings(minutes, max_per_hour, max_pending),
            Adapter::Mcp(family) => family.set_settings(minutes, max_per_hour, max_pending),
            Adapter::Release(family) => family.set_settings(minutes, max_per_hour, max_pending),
        }
    }

    async fn disable_timer(&self) -> Option<AgentResult> {
        match self {
            Adapter::Watchdog(family) => Some(family.disable_timer().await),
            _ => None,
        }
    }

    /// Whether a live forge read is due, spawning one when it is.
    fn schedule_forge(&self, weak: &Weak<AgentsMode>, has_clients: bool, now: i64) {
        let (id, forge) = match self {
            Adapter::Repo(family) if family.family_id.uses_forge() => {
                (family.descriptor.id, &family.forge)
            }
            Adapter::Watchdog(family) => (family.descriptor.id, &family.forge),
            Adapter::Mcp(family) => (family.descriptor.id, &family.forge),
            _ => return,
        };
        if !forge.due(now, has_clients) {
            return;
        }
        let all_urls = self.forge_urls();
        let urls = forge.pending_urls(all_urls.clone());
        if urls.is_empty() {
            if all_urls.is_empty() {
                forge.note_empty_read(now);
            } else {
                // Every URL is already resolved: finish the cycle without a
                // request and keep the cached answers.
                forge.apply(Vec::new(), Vec::new(), now);
            }
            return;
        }
        let Some(reader) = forge.reader.clone() else {
            return;
        };
        let weak = weak.clone();
        tokio::spawn(async move {
            let result = reader(urls.clone()).await;
            let Some(mode) = weak.upgrade() else {
                return;
            };
            let Some(adapter) = mode.adapters.iter().find(|adapter| adapter.id() == id) else {
                return;
            };
            let forge = adapter.forge_ref().expect("a family with a forge");
            match result {
                Ok(facts) => forge.apply(urls, facts, now_millis()),
                Err(detail) => forge.fail(detail, now_millis()),
            }
            mode.publish_if_changed(adapter);
        });
    }

    fn forge_ref(&self) -> Option<&ForgeProjection> {
        match self {
            Adapter::Repo(family) if family.family_id.uses_forge() => Some(&family.forge),
            Adapter::Watchdog(family) => Some(&family.forge),
            Adapter::Mcp(family) => Some(&family.forge),
            _ => None,
        }
    }

    fn forge_urls(&self) -> Vec<String> {
        match self {
            Adapter::Repo(family) => family.forge_urls(),
            Adapter::Watchdog(family) => family.forge_urls(),
            Adapter::Mcp(family) => family.forge_urls(),
            Adapter::Release(_) => Vec::new(),
        }
    }

    fn poll_activity(&self, shared: &Shared) {
        if let Adapter::Repo(family) = self {
            family.poll_activity(shared);
        }
    }

    /// A cheap fingerprint of everything the family's snapshot reads from
    /// disk. Metadata only: the projection and its serialization run only
    /// after this changes.
    fn poll_signature(&self) -> u64 {
        match self {
            Adapter::Repo(family) => family.poll_signature(),
            Adapter::Watchdog(family) => family.poll_signature(),
            Adapter::Mcp(family) => family.poll_signature(),
            Adapter::Release(family) => family.poll_signature(),
        }
    }

    /// Whether the snapshot changes with time alone, so it must be rebuilt on
    /// every tick regardless of the file fingerprint.
    fn rebuild_always(&self) -> bool {
        match self {
            Adapter::Repo(family) => family.rebuild_always(),
            Adapter::Watchdog(family) => family.rebuild_always(),
            Adapter::Mcp(family) => family.rebuild_always(),
            Adapter::Release(family) => family.rebuild_always(),
        }
    }
}

/// One Start command's preview: the family reads `starting` from the moment the
/// operator asks until the command answers, and the window closes however that
/// command ends. A dropped connection, a cancelled command, or a panicking
/// handler must not leave a preview behind, because `starting` disables Start.
struct PreviewWindow<'a>(&'a Adapter);

impl Drop for PreviewWindow<'_> {
    fn drop(&mut self) {
        self.0.clear_preview();
    }
}

#[derive(Clone, Debug)]
struct AgentResult {
    ok: bool,
    message: Option<String>,
}

impl AgentResult {
    fn ok() -> Self {
        Self {
            ok: true,
            message: None,
        }
    }

    fn failure(text: String) -> Self {
        Self {
            ok: false,
            message: Some(text),
        }
    }
}

impl AgentsMode {
    fn new(app: &Arc<App>) -> Arc<Self> {
        let shared = Arc::clone(&app.shared);
        let repo_dir = app.config().repo_dir.clone();
        let state_dir = app.config().state_dir.clone();
        let environment = process_environment();
        let now: Arc<dyn Fn() -> i64 + Send + Sync> = Arc::new(now_millis);
        let running_version = app.running_version.clone();
        let agent_command = app.config().agent_command.clone();
        let weak = Arc::downgrade(app);
        let agent_environment: Arc<AgentEnvironment> = Arc::new(move || {
            let weak = weak.clone();
            Box::pin(async move {
                let Some(app) = weak.upgrade() else {
                    return Err("the dashboard is stopping".to_string());
                };
                app.providers
                    .select_environment()
                    .await
                    .map(|environment| {
                        environment
                            .into_iter()
                            .filter_map(|(key, value)| value.map(|value| (key, value)))
                            .collect()
                    })
                    .map_err(|error| error.to_string())
            })
        });
        let spawn: SharedSpawn = Arc::new(Mutex::new(Arc::new(default_spawn) as SpawnFn));
        let agent_environment_cell = Arc::new(Mutex::new(agent_environment.clone()));
        let forge_reader = match crate::forge::origin_forge_with(&repo_dir, &environment) {
            Some(remote) if remote.forge != crate::forge::Forge::GitLab => {
                Some(live_forge_reader(repo_dir.clone(), environment.clone()))
            }
            _ => None,
        };
        let new_preflight = || -> SharedPreflight { Arc::new(Mutex::new(None)) };
        let mut adapters = Vec::new();
        for family_id in [
            RepoFamilyId::Scout,
            RepoFamilyId::Design,
            RepoFamilyId::DeadCode,
            RepoFamilyId::ApiStandards,
            RepoFamilyId::SingleResponsibility,
            RepoFamilyId::ConsistentNaming,
        ] {
            adapters.push(Adapter::Repo(RepoFamily::new(
                family_id,
                &repo_dir,
                &state_dir,
                &environment,
                &agent_command,
                running_version.clone(),
                Arc::clone(&agent_environment_cell),
                spawn.clone(),
                new_preflight(),
                forge_reader.clone(),
                now.clone(),
            )));
        }
        // Registry order: scout, watchdog, design, dead-code, mcp-optimizer,
        // api-standards, single-responsibility, consistent-naming, release-train.
        let mut ordered = Vec::new();
        let mut indices: HashMap<&'static str, Adapter> = adapters
            .into_iter()
            .map(|adapter| (adapter.id(), adapter))
            .collect();
        ordered.push(indices.remove("scout").expect("scout"));
        ordered.push(Adapter::Watchdog(WatchdogFamily::new(
            &repo_dir,
            &state_dir,
            &environment,
            running_version.clone(),
            spawn.clone(),
            new_preflight(),
            forge_reader.clone(),
            now.clone(),
        )));
        ordered.push(indices.remove("design").expect("design"));
        ordered.push(indices.remove("dead-code").expect("dead-code"));
        ordered.push(Adapter::Mcp(McpFamily::new(
            &repo_dir,
            &state_dir,
            &environment,
            running_version.clone(),
            spawn.clone(),
            new_preflight(),
            forge_reader.clone(),
            now.clone(),
        )));
        ordered.push(indices.remove("api-standards").expect("api-standards"));
        ordered.push(
            indices
                .remove("single-responsibility")
                .expect("single-responsibility"),
        );
        ordered.push(
            indices
                .remove("consistent-naming")
                .expect("consistent-naming"),
        );
        ordered.push(Adapter::Release(ReleaseFamily::new(
            &repo_dir,
            &state_dir,
            &environment,
            running_version.clone(),
            spawn.clone(),
            now.clone(),
        )));
        let shared_for_clients = Arc::clone(&shared);
        Arc::new(Self {
            prompts: PromptController {
                repo_dir: repo_dir.clone(),
                state_dir: state_dir.clone(),
                open_issues: Arc::new(Mutex::new(None)),
            },
            shared,
            adapters: ordered,
            signatures: Mutex::new(HashMap::new()),
            cached: Mutex::new(HashMap::new()),
            poll_signatures: Mutex::new(HashMap::new()),
            settle_until: Mutex::new(0),
            has_clients: Arc::new(move || shared_for_clients.has_clients()),
        })
    }

    fn begin(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        for adapter in &self.adapters {
            if matches!(adapter, Adapter::Watchdog(_)) {
                let weak = weak.clone();
                tokio::spawn(async move {
                    let mut interval = tokio::time::interval(Duration::from_millis(1_000));
                    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                    loop {
                        interval.tick().await;
                        let Some(mode) = weak.upgrade() else {
                            break;
                        };
                        let refresh = mode.adapters.iter().find_map(|adapter| match adapter {
                            Adapter::Watchdog(family) => Some(family.refresh_timer(false)),
                            _ => None,
                        });
                        match refresh {
                            Some(task) => task.await,
                            None => break,
                        }
                    }
                });
            }
        }
        let weak_takeover = weak.clone();
        tokio::spawn(async move {
            let Some(mode) = weak_takeover.upgrade() else {
                return;
            };
            for adapter in &mode.adapters {
                adapter.takeover().await;
            }
        });
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(POLL_MS));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            // `setInterval` in the reference fires first after one period, not
            // immediately; the first tick here only arms the cadence.
            interval.tick().await;
            loop {
                interval.tick().await;
                let Some(mode) = weak.upgrade() else {
                    break;
                };
                mode.poll(&weak);
            }
        });
    }

    fn poll(&self, weak: &Weak<AgentsMode>) {
        let now = now_millis();
        if self
            .settle_until
            .lock()
            .map(|settle| now < *settle)
            .unwrap_or(false)
        {
            return;
        }
        let has_clients = (self.has_clients)();
        for adapter in &self.adapters {
            adapter.schedule_forge(weak, has_clients, now);
        }
        for adapter in &self.adapters {
            adapter.poll_activity(&self.shared);
            if self.poll_should_rebuild(adapter) {
                self.publish_if_changed(adapter);
            }
        }
    }

    /// Whether the poll owes this family a projection. A family whose state
    /// fingerprint is unchanged is neither rebuilt nor serialized, and a
    /// family with an in-flight start, stop, or timer read is always rebuilt
    /// because its snapshot changes with time alone.
    fn poll_should_rebuild(&self, adapter: &Adapter) -> bool {
        let signature = adapter.poll_signature();
        let changed = {
            let Ok(mut signatures) = self.poll_signatures.lock() else {
                return true;
            };
            let previous = signatures.insert(adapter.id(), signature);
            previous != Some(signature)
        };
        changed || adapter.rebuild_always()
    }

    fn publish_if_changed(&self, adapter: &Adapter) {
        let snapshot = adapter.snapshot();
        self.store_projection(adapter, &snapshot);
        let text = crate::jsjson::stringify(&snapshot);
        let changed = {
            let Ok(mut signatures) = self.signatures.lock() else {
                return;
            };
            if signatures.get(adapter.id()) == Some(&text) {
                false
            } else {
                signatures.insert(adapter.id(), text);
                true
            }
        };
        if changed {
            self.shared.send_all(
                json!({
                    "type": "agentState",
                    "agent": snapshot,
                }),
                None,
            );
        }
    }

    fn store_projection(&self, adapter: &Adapter, snapshot: &Value) {
        if let Ok(mut cached) = self.cached.lock() {
            cached.insert(adapter.id(), snapshot.clone());
        }
    }

    /// The family's last projection, computed once when no tick has produced
    /// one yet. The poll keeps it current, so a replay or a read never walks
    /// nine families' state on the socket's critical path.
    fn project(&self, adapter: &Adapter) -> Value {
        if let Ok(cached) = self.cached.lock() {
            if let Some(value) = cached.get(adapter.id()) {
                return value.clone();
            }
        }
        let snapshot = adapter.snapshot();
        self.store_projection(adapter, &snapshot);
        snapshot
    }

    fn publish_agent(&self, adapter: &Adapter) {
        let agent = adapter.snapshot();
        self.store_projection(adapter, &agent);
        let text = crate::jsjson::stringify(&agent);
        if let Ok(mut signatures) = self.signatures.lock() {
            signatures.insert(adapter.id(), text);
        }
        self.shared.send_all(
            json!({
                "type": "agentState",
                "agent": agent,
            }),
            None,
        );
    }

    fn send_agent(&self, conn: &Conn, adapter: &Adapter) {
        // A targeted read is a fresh projection. This is the proof read: a
        // Start's worker proves itself by publishing its lock, and the answer
        // must show it. The page-open read is `answer_refresh`, which never
        // walks the state tree.
        let agent = adapter.snapshot();
        self.store_projection(adapter, &agent);
        conn.send(json!({
            "type": "agentState",
            "agent": agent,
        }));
    }

    /// Answers the projection the poll maintains. The refresh command's nudge
    /// makes the worker re-read, and the poll publishes what it finds, so this
    /// read never walks the family's state tree.
    fn answer_refresh(&self, conn: &Conn, adapter: &Adapter) {
        let agent = self.project(adapter);
        conn.send(json!({
            "type": "agentState",
            "agent": agent,
        }));
    }

    fn snapshot_all(&self) -> Vec<Value> {
        self.adapters
            .iter()
            .map(|adapter| self.project(adapter))
            .collect()
    }

    fn replay_agents(&self, conn: &Conn) {
        self.replay_agents_inner(conn, true, true);
    }

    /// `getAgents` answers from the cached projections. The timer read and the
    /// per-family activity replay belong to the connect replay; a read is one
    /// `agentsState` frame and completes without waiting for them.
    fn answer_get_agents(&self, conn: &Conn) {
        self.replay_agents_inner(conn, false, false);
    }

    fn replay_agents_inner(&self, conn: &Conn, refresh_timer: bool, replay_activity: bool) {
        if let Ok(mut settle) = self.settle_until.lock() {
            *settle = now_millis() + 1_000;
        }
        if refresh_timer {
            for adapter in &self.adapters {
                if let Adapter::Watchdog(family) = adapter {
                    family.refresh_timer_now();
                }
            }
        }
        let snapshots = self.snapshot_all();
        conn.send(json!({
            "type": "agentsState",
            "agents": snapshots.clone(),
        }));
        // A connect is the baseline the poll cadence compares against: the
        // frames this replay sent never repeat as unsolicited broadcasts.
        if let Ok(mut signatures) = self.signatures.lock() {
            for (adapter, snapshot) in self.adapters.iter().zip(snapshots.iter()) {
                signatures.insert(adapter.id(), crate::jsjson::stringify(snapshot));
            }
        }
        if !replay_activity {
            return;
        }
        for (adapter, snapshot) in self.adapters.iter().zip(snapshots) {
            adapter.replay(conn, &self.shared, snapshot);
        }
    }

    fn replay(&self, conn: &Conn) {
        self.replay_agents(conn);
        self.prompts.replay(conn);
    }

    async fn handle(&self, conn: &Conn, command: &Command) -> bool {
        match command {
            Command::GetAgents => {
                self.answer_get_agents(conn);
                true
            }
            Command::GetAgent { id } => {
                let Some(id) = agent_id(id) else {
                    conn.send(
                        json!({"type": "error", "message": "An agent command needs its agent id."}),
                    );
                    return true;
                };
                let Some(adapter) = self.adapters.iter().find(|adapter| adapter.id() == id) else {
                    conn.send(json!({"type": "error", "message": format!("Unknown background agent: {id}.")}));
                    return true;
                };
                self.send_agent(conn, adapter);
                true
            }
            Command::RefreshAgent { id } => {
                let Some(id) = agent_id(id) else {
                    conn.send(
                        json!({"type": "error", "message": "An agent command needs its agent id."}),
                    );
                    return true;
                };
                let Some(adapter) = self.adapters.iter().find(|adapter| adapter.id() == id) else {
                    conn.send(json!({"type": "error", "message": format!("Unknown background agent: {id}.")}));
                    return true;
                };
                adapter.request_sync();
                self.answer_refresh(conn, adapter);
                true
            }
            Command::StartAgent { id } => {
                let Some(id) = agent_id(id) else {
                    conn.send(
                        json!({"type": "error", "message": "An agent command needs its agent id."}),
                    );
                    return true;
                };
                let Some(adapter) = self.adapters.iter().find(|adapter| adapter.id() == id) else {
                    conn.send(json!({"type": "error", "message": format!("Unknown background agent: {id}.")}));
                    return true;
                };
                adapter.preview_start();
                let preview = PreviewWindow(adapter);
                let pending = adapter.start();
                self.publish_agent(adapter);
                let result = pending.await;
                drop(preview);
                self.finish(conn, adapter, result);
                true
            }
            Command::StopAgent { id } => {
                let Some(id) = agent_id(id) else {
                    conn.send(
                        json!({"type": "error", "message": "An agent command needs its agent id."}),
                    );
                    return true;
                };
                let Some(adapter) = self.adapters.iter().find(|adapter| adapter.id() == id) else {
                    conn.send(json!({"type": "error", "message": format!("Unknown background agent: {id}.")}));
                    return true;
                };
                let result = adapter.stop();
                self.finish(conn, adapter, result);
                true
            }
            Command::SetAgentSettings {
                id,
                minutes,
                max_per_hour,
                max_pending,
            } => {
                let Some(id) = agent_id(id) else {
                    conn.send(
                        json!({"type": "error", "message": "An agent command needs its agent id."}),
                    );
                    return true;
                };
                let Some(adapter) = self.adapters.iter().find(|adapter| adapter.id() == id) else {
                    conn.send(json!({"type": "error", "message": format!("Unknown background agent: {id}.")}));
                    return true;
                };
                let result = adapter.set_settings(
                    minutes.as_ref().and_then(Value::as_u64),
                    max_per_hour.clone(),
                    max_pending.clone(),
                );
                self.finish(conn, adapter, result);
                true
            }
            Command::DisableAgentTimer { id } => {
                let Some(id) = agent_id(id) else {
                    conn.send(
                        json!({"type": "error", "message": "An agent command needs its agent id."}),
                    );
                    return true;
                };
                let Some(adapter) = self.adapters.iter().find(|adapter| adapter.id() == id) else {
                    conn.send(json!({"type": "error", "message": format!("Unknown background agent: {id}.")}));
                    return true;
                };
                match adapter.disable_timer().await {
                    Some(result) => {
                        self.publish_agent(adapter);
                        if !result.ok {
                            conn.send(json!({
                                "type": "error",
                                "message": result.message.unwrap_or_default(),
                            }));
                        }
                    }
                    None => {
                        conn.send(json!({
                            "type": "error",
                            "message": format!(
                                "{} has no legacy timer to disable.",
                                adapter.descriptor().label
                            ),
                        }));
                    }
                }
                true
            }
            Command::GetAgentPrompt { id } => {
                let Some(id) = prompt_id(id) else {
                    conn.send(
                        json!({"type": "error", "message": "An agent prompt needs its agent id."}),
                    );
                    return true;
                };
                self.prompts.replay_one(conn, id);
                true
            }
            _ => false,
        }
    }

    fn finish(&self, conn: &Conn, adapter: &Adapter, result: AgentResult) {
        self.publish_agent(adapter);
        if !result.ok {
            conn.send(json!({
                "type": "error",
                "message": result.message.unwrap_or_default(),
            }));
        }
    }
}

fn agent_id(value: &Option<Value>) -> Option<&str> {
    value
        .as_ref()
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
}

fn prompt_id(value: &Option<Value>) -> Option<&str> {
    agent_id(value)
}

/// One Start prerequisite check, as a family's options expose it.
pub struct PreflightRequest {
    pub family: String,
    pub repo_dir: PathBuf,
    pub state_dir: PathBuf,
    pub environment: HashMap<String, String>,
}

pub type PreflightCallback = Arc<
    dyn Fn(PreflightRequest) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send>>
        + Send
        + Sync,
>;
type SharedPreflight = Arc<Mutex<Option<PreflightCallback>>>;
type SharedSpawn = Arc<Mutex<SpawnFn>>;
type AgentEnvironment = dyn Fn() -> Pin<Box<dyn Future<Output = Result<HashMap<String, String>, String>> + Send>>
    + Send
    + Sync;
type SpawnFn = Arc<dyn Fn(&[String], HashMap<String, String>) -> Option<u32> + Send + Sync>;

fn default_spawn(argv: &[String], environment: HashMap<String, String>) -> Option<u32> {
    let options = crate::supervision::SupervisedDetachOptions {
        cwd: environment
            .get("REPO_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(".")),
        state_dir: environment.get("STATE_DIR").map(PathBuf::from),
        env: environment,
        ..crate::supervision::SupervisedDetachOptions::default()
    };
    crate::supervision::supervised_detach(argv, options)
}

fn harness_argv(family: &str, flags: &[(&str, &Path)]) -> Vec<String> {
    let mut argv = vec![
        crate::relaunch::own_program()
            .to_string_lossy()
            .into_owned(),
        "worker".to_string(),
        family.to_string(),
    ];
    for (name, value) in flags {
        argv.push(format!("--{name}"));
        argv.push(value.to_string_lossy().into_owned());
    }
    argv
}

fn provider_environment(
    base: &HashMap<String, String>,
    extra: &[(&str, &str)],
) -> HashMap<String, String> {
    let mut environment = base.clone();
    for (key, value) in extra {
        environment.insert((*key).to_string(), (*value).to_string());
    }
    environment
}

/* ------------------------------------------------------------------------ */
/* Mode registry                                                             */
/* ------------------------------------------------------------------------ */

fn modes() -> &'static Mutex<HashMap<usize, Arc<AgentsMode>>> {
    static MODES: std::sync::LazyLock<Mutex<HashMap<usize, Arc<AgentsMode>>>> =
        std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
    &MODES
}

fn mode_key(app: &Arc<App>) -> usize {
    Arc::as_ptr(app) as usize
}

fn mode_for(app: &Arc<App>) -> Option<Arc<AgentsMode>> {
    modes()
        .lock()
        .ok()
        .and_then(|modes| modes.get(&mode_key(app)).cloned())
}

/// Replaces the detached spawn for this dashboard. Tests use it to observe the
/// argv a Start would run without starting a worker.
pub fn set_spawn(
    app: &Arc<App>,
    spawn: impl Fn(&[String], HashMap<String, String>) -> Option<u32> + Send + Sync + 'static,
) {
    if let Some(mode) = mode_for(app) {
        let spawn: SpawnFn = Arc::new(spawn);
        for adapter in &mode.adapters {
            let cell = match adapter {
                Adapter::Repo(family) => Some(&family.spawn),
                Adapter::Watchdog(family) => Some(&family.spawn),
                Adapter::Mcp(family) => Some(&family.spawn),
                Adapter::Release(family) => Some(&family.spawn),
            };
            if let Some(cell) = cell {
                if let Ok(mut slot) = cell.lock() {
                    *slot = Arc::clone(&spawn);
                }
            }
        }
    }
}

/// Replaces one family's Start prerequisite check. Tests use it to prove the
/// start/stop dispositions without a forge.
pub fn set_preflight(app: &Arc<App>, family: &str, callback: PreflightCallback) {
    if let Some(mode) = mode_for(app) {
        for adapter in &mode.adapters {
            if adapter.id() != family {
                continue;
            }
            if let Some(cell) = adapter.preflight_cell() {
                if let Ok(mut slot) = cell.lock() {
                    *slot = Some(Arc::clone(&callback));
                }
            }
        }
    }
}

/// Replaces the wall-clock bound a family's Start gives its preflight. Tests
/// use it so a hanging preflight answers in milliseconds instead of the 20
/// second production bound.
pub fn set_preflight_timeout(app: &Arc<App>, family: &str, timeout_ms: u64) {
    if let Some(mode) = mode_for(app) {
        for adapter in &mode.adapters {
            if adapter.id() != family {
                continue;
            }
            if let Some(cell) = adapter.preflight_timeout_cell() {
                cell.store(timeout_ms.max(1), Ordering::SeqCst);
            }
        }
    }
}

/// Runs one background-agent poll tick. Tests use it to prove an idle
/// dashboard rebroadcasts nothing.
pub fn poll_once(app: &Arc<App>) {
    if let Some(mode) = mode_for(app) {
        let weak = Arc::downgrade(&mode);
        mode.poll(&weak);
    }
}

/// Replaces the provider environment a repo family's Start resolves. Tests use
/// it where no subscription is configured.
pub fn set_agent_environment(
    app: &Arc<App>,
    environment: impl Fn() -> Pin<Box<dyn Future<Output = Result<HashMap<String, String>, String>> + Send>>
        + Send
        + Sync
        + 'static,
) {
    if let Some(mode) = mode_for(app) {
        let environment: Arc<AgentEnvironment> = Arc::new(environment);
        for adapter in &mode.adapters {
            if let Adapter::Repo(family) = adapter {
                if let Ok(mut slot) = family.agent_environment.lock() {
                    *slot = Arc::clone(&environment);
                }
            }
        }
    }
}

/// A dashboard-free snapshot of every background agent, from its durable
/// worker state, settings, ledger, and projection. A live dashboard's own
/// replay is richer; this is what an MCP tool answers when no dashboard
/// serves the repository.
pub fn persisted_snapshots(state_dir: &Path, repo_dir: &Path) -> Vec<Value> {
    DESCRIPTORS
        .iter()
        .map(|descriptor| persisted_snapshot(descriptor, state_dir, repo_dir))
        .collect()
}

fn family_directory(state_dir: &Path, id: &str) -> PathBuf {
    state_dir.join(id)
}

/// The newest file named `name` under `root`, by modification time.
fn newest_state_file(root: &Path, name: &str) -> Option<Value> {
    fn visit(
        directory: &Path,
        name: &str,
        depth: usize,
        best: &mut Option<(std::time::SystemTime, Value)>,
    ) {
        if depth > 5 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(directory) else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if kind.is_dir() {
                visit(&path, name, depth + 1, best);
                continue;
            }
            if entry.file_name().to_string_lossy() != name {
                continue;
            }
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            if best.as_ref().is_some_and(|(at, _)| *at > modified) {
                continue;
            }
            if let Some(value) = read_json(&path) {
                *best = Some((modified, value));
            }
        }
    }
    let mut best = None;
    visit(root, name, 0, &mut best);
    best.map(|(_, value)| value)
}

fn object_text(value: Option<&Value>, key: &str) -> Option<String> {
    value
        .and_then(Value::as_object)
        .and_then(|object| object.get(key))
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn object_bool(value: Option<&Value>, key: &str) -> Option<bool> {
    value
        .and_then(Value::as_object)
        .and_then(|object| object.get(key))
        .and_then(Value::as_bool)
}

fn object_limit(value: Option<&Value>, key: &str) -> Option<u32> {
    value
        .and_then(Value::as_object)
        .and_then(|object| object.get(key))
        .and_then(Value::as_u64)
        .and_then(|number| u32::try_from(number).ok())
}

fn persisted_snapshot(descriptor: &Descriptor, state_dir: &Path, repo_dir: &Path) -> Value {
    let directory = family_directory(state_dir, descriptor.id);
    let state = newest_state_file(&directory, "state.json");
    let worker = newest_state_file(&directory, "worker.json");
    let settings = newest_state_file(&directory, "settings.json");
    let projection = newest_state_file(&directory, "projection.json");
    let reader = |key: &str| {
        object_text(worker.as_ref(), key)
            .or_else(|| object_text(state.as_ref(), key))
            .or_else(|| object_text(settings.as_ref(), key))
    };
    let lifecycle = reader("lifecycle").unwrap_or_else(|| "stopped".to_string());
    let enabled = object_bool(worker.as_ref(), "enabled")
        .or_else(|| object_bool(state.as_ref(), "enabled"))
        .or_else(|| object_bool(settings.as_ref(), "enabled"))
        .unwrap_or(false);
    let paused = object_bool(worker.as_ref(), "paused")
        .or_else(|| object_bool(state.as_ref(), "paused"))
        .unwrap_or(false);
    let owner = worker
        .as_ref()
        .and_then(|value| value.get("pid"))
        .and_then(Value::as_u64)
        .and_then(|pid| u32::try_from(pid).ok())
        .filter(|pid| pid_alive(*pid));
    let attached = owner.is_some();
    let owned = attached
        && object_text(worker.as_ref(), "stateDir")
            .map(PathBuf::from)
            .map(|path| resolved(&path) == resolved(state_dir))
            .unwrap_or(false);
    let minutes = object_limit(worker.as_ref(), "intervalMinutes")
        .or_else(|| object_limit(state.as_ref(), "intervalMinutes"))
        .or_else(|| object_limit(settings.as_ref(), "intervalMinutes"))
        .unwrap_or(descriptor.default_minutes);
    let limits = Limits {
        max_per_hour: object_limit(state.as_ref(), "maxPerHour")
            .or_else(|| {
                state
                    .as_ref()
                    .and_then(|value| value.get("limits"))
                    .and_then(|limits| limits.get("maxPerHour"))
                    .and_then(Value::as_u64)
                    .and_then(|number| u32::try_from(number).ok())
            })
            .or_else(|| object_limit(settings.as_ref(), "maxPerHour")),
        max_pending: object_limit(state.as_ref(), "maxPending")
            .or_else(|| {
                state
                    .as_ref()
                    .and_then(|value| value.get("limits"))
                    .and_then(|limits| limits.get("maxPending"))
                    .and_then(Value::as_u64)
                    .and_then(|number| u32::try_from(number).ok())
            })
            .or_else(|| object_limit(settings.as_ref(), "maxPending")),
    };
    let mut issues: Vec<Value> = state
        .as_ref()
        .and_then(|value| value.get("issues"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if issues.is_empty() {
        issues = state
            .as_ref()
            .and_then(|value| value.get("findings"))
            .and_then(Value::as_object)
            .map(|findings| {
                findings
                    .values()
                    .filter_map(|finding| {
                        let disposition = finding.get("disposition")?.as_str()?;
                        let url = disposition.strip_prefix("filed:")?;
                        Some(json!({
                            "title": finding.get("line").cloned().unwrap_or(Value::Null),
                            "category": finding.get("category").cloned().unwrap_or(Value::Null),
                            "filedAt": finding.get("filedAt").cloned().unwrap_or(Value::Null),
                            "url": url,
                            "state": "filed",
                        }))
                    })
                    .collect()
            })
            .unwrap_or_default();
    }
    let pending = state
        .as_ref()
        .and_then(|value| value.get("pending"))
        .and_then(Value::as_u64)
        .unwrap_or_else(|| {
            let findings = state
                .as_ref()
                .and_then(|value| value.get("findings"))
                .and_then(Value::as_object)
                .map(|findings| findings.len())
                .unwrap_or(0);
            (findings as u64).saturating_sub(issues.len() as u64)
        });
    let sync = state
        .as_ref()
        .and_then(|value| value.get("sync"))
        .and_then(|sync| sync.as_object())
        .map(|sync| AgentSync {
            state: sync
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("stale")
                .to_string(),
            at: sync.get("at").and_then(Value::as_str).map(str::to_string),
            error: sync
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string),
        })
        .unwrap_or_else(AgentSync::stale);
    if issues.is_empty() {
        issues = projection
            .as_ref()
            .and_then(|value| value.get("issues"))
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .map(|row| {
                        json!({
                            "title": row.get("title").cloned().unwrap_or(Value::Null),
                            "category": row.get("category").cloned().unwrap_or(Value::Null),
                            "filedAt": projection
                                .as_ref()
                                .and_then(|value| value.get("at"))
                                .cloned()
                                .unwrap_or(Value::Null),
                            "url": row.get("url").cloned().unwrap_or(Value::Null),
                            "state": "filed",
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
    }
    let mut entries: Vec<String> = read_activity(&directory);
    if let Some(activity) = state
        .as_ref()
        .and_then(|value| value.get("activity"))
        .and_then(Value::as_array)
    {
        for line in activity {
            if let Some(line) = line.as_str() {
                entries.push(line.to_string());
            }
        }
    }
    if let Some(runs) = state
        .as_ref()
        .and_then(|value| value.get("runs"))
        .and_then(Value::as_array)
    {
        for run in runs {
            if let Some(id) = run.get("id").and_then(Value::as_str) {
                entries.push(id.to_string());
            }
        }
    }
    if let Some(cycles) = state
        .as_ref()
        .and_then(|value| value.get("cycles"))
        .and_then(Value::as_array)
    {
        for cycle in cycles {
            if let Some(id) = cycle
                .as_str()
                .or_else(|| cycle.get("id").and_then(Value::as_str))
            {
                entries.push(id.to_string());
            }
        }
    }
    if entries.is_empty() {
        entries = projection
            .as_ref()
            .and_then(|value| value.get("issues"))
            .and_then(Value::as_array)
            .map(|issues| {
                issues
                    .iter()
                    .filter_map(|issue| issue.get("title").and_then(Value::as_str))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
    }
    let last_run_at = reader("lastRunAt")
        .or_else(|| reader("lastCycleStartedAt"))
        .or_else(|| reader("lastRunAt"));
    let next_run_at = reader("nextRunAt").or_else(|| reader("nextAttemptAt"));
    let detail = Detail::Activity {
        scan_id: reader("newestCycleId").or_else(|| reader("scanId")),
        entries,
    };
    let _ = repo_dir;
    project_snapshot(
        descriptor,
        SnapshotInput {
            lifecycle,
            paused,
            enabled,
            owned,
            attached,
            minutes,
            last_run_at,
            next_run_at,
            limits,
            issues,
            documentation: state
                .as_ref()
                .and_then(|value| value.get("documentation"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            releases: state
                .as_ref()
                .and_then(|value| value.get("releases"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            pending,
            sync,
            detail,
            notice: reader("notice"),
            error: reader("lastError").or_else(|| reader("error")),
            timer: None,
            workers: Vec::new(),
        },
    )
}

/// Registers this mode's durable state with the dashboard.
pub fn init(app: &Arc<App>) {
    let mode = AgentsMode::new(app);
    if let Ok(mut modes) = modes().lock() {
        modes.insert(mode_key(app), Arc::clone(&mode));
    }
    mode.begin();
}

/// Replaces the open issues every generated template is built from and
/// republishes those templates. Called after a fresh open-issue read.
pub fn publish_prompt_templates(app: &Arc<App>, open_issues: Vec<Value>) {
    let Some(mode) = mode_for(app) else {
        return;
    };
    if let Ok(mut issues) = mode.prompts.open_issues.lock() {
        *issues = Some(open_issues);
    }
    mode.prompts.publish_templates(&mode.shared);
}

/// Replays the frames a connecting client owes before its own replies.
pub fn replay(app: &Arc<App>, conn: &Conn) {
    if let Some(mode) = mode_for(app) {
        mode.replay(conn);
    }
}

/// Applies one command; `false` when it belongs to another mode.
pub async fn handle(app: &Arc<App>, conn: &Conn, command: &Command) -> bool {
    match mode_for(app) {
        Some(mode) => mode.handle(conn, command).await,
        None => false,
    }
}

/// Runs one detached worker engine.
pub async fn run_worker(family: &str, args: &[String]) -> anyhow::Result<()> {
    let mut full = Vec::new();
    if args.first().map(String::as_str) != Some(family) {
        full.push(family.to_string());
    }
    full.extend(args.iter().cloned());
    let invocation = crate::workers::parse(&full)?;
    crate::workers::run(&invocation).await
}

/* ------------------------------------------------------------------------ */
/* Family adapters                                                           */
/* ------------------------------------------------------------------------ */

// The family implementations follow.

/* ------------------------------------------------------------------------ */
/* Repository families                                                       */
/* ------------------------------------------------------------------------ */

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum RepoFamilyId {
    Scout,
    Design,
    DeadCode,
    ApiStandards,
    SingleResponsibility,
    ConsistentNaming,
}

impl RepoFamilyId {
    fn directory(self) -> &'static str {
        match self {
            Self::Scout => "scout",
            Self::Design => "design",
            Self::DeadCode => "dead-code",
            Self::ApiStandards => "api-standards",
            Self::SingleResponsibility => "single-responsibility",
            Self::ConsistentNaming => "consistent-naming",
        }
    }

    fn state_version(self) -> u64 {
        if self == Self::Scout {
            2
        } else {
            1
        }
    }

    fn worker_label(self) -> &'static str {
        match self {
            Self::Scout => "Auto Scout",
            Self::Design => "Design System",
            Self::DeadCode => "Dead Code",
            Self::ApiStandards => "API Standards",
            Self::SingleResponsibility => "Single Responsibility",
            Self::ConsistentNaming => "Consistent Naming",
        }
    }

    fn cycle_directory(self) -> &'static str {
        if self == Self::Scout {
            "scans"
        } else {
            "cycles"
        }
    }

    fn default_minutes(self) -> u32 {
        if self == Self::Scout {
            1
        } else {
            60
        }
    }

    fn default_limits(self) -> Limits {
        Limits {
            max_per_hour: Some(10),
            max_pending: Some(5),
        }
    }

    fn uses_forge(self) -> bool {
        matches!(
            self,
            Self::Scout
                | Self::Design
                | Self::DeadCode
                | Self::SingleResponsibility
                | Self::ConsistentNaming
        )
    }

    fn active_lifecycle(self) -> &'static str {
        match self {
            Self::Scout => "scanning",
            _ => "auditing",
        }
    }

    fn lifecycle_allowed(self, value: &str) -> bool {
        match self {
            Self::Scout => matches!(value, "stopped" | "idle" | "scanning" | "failed"),
            Self::Design => matches!(
                value,
                "stopped" | "idle" | "auditing" | "releasing" | "failed"
            ),
            Self::DeadCode => matches!(value, "stopped" | "idle" | "detecting" | "failed"),
            Self::ApiStandards | Self::SingleResponsibility | Self::ConsistentNaming => {
                matches!(value, "stopped" | "idle" | "auditing" | "failed")
            }
        }
    }

    /// The control command name the worker consumes for one fresh read.
    fn refreshes_worker(self) -> bool {
        matches!(
            self,
            Self::Scout | Self::DeadCode | Self::SingleResponsibility | Self::ConsistentNaming
        )
    }
}

/// The worker record shape the reference validates when it reads `state.json`;
/// only `pid` is read after parsing.
#[allow(dead_code)]
#[derive(Clone, Debug)]
struct WorkerRecord {
    pid: u32,
    started_at: String,
    state_dir: String,
    harness_version: Option<String>,
    argv: Vec<String>,
}

#[derive(Clone, Debug)]
struct RepoState {
    lifecycle: String,
    enabled: bool,
    worker: Option<WorkerRecord>,
    limits: Limits,
    interval_minutes: u32,
    last_cycle_started_at: Option<String>,
    issues: Vec<Value>,
    sync: AgentSync,
    newest_cycle_id: Option<String>,
    documentation: Vec<Value>,
    next_attempt_at: Option<String>,
    last_error: Option<String>,
    notice: Option<String>,
    draining: bool,
    updated_at: String,
    active_cycle_started_at: Option<String>,
}

fn valid_worker(value: &Value) -> Option<WorkerRecord> {
    let object = value.as_object()?;
    let pid = object.get("pid")?.as_u64()? as u32;
    let started_at = object.get("startedAt")?.as_str()?.to_string();
    let state_dir = object.get("stateDir")?.as_str()?.to_string();
    let harness_version = match object.get("harnessVersion") {
        Some(Value::Null) => None,
        Some(Value::String(text)) => Some(text.clone()),
        _ => return None,
    };
    let argv = object
        .get("argv")?
        .as_array()?
        .iter()
        .map(|entry| entry.as_str().map(str::to_string))
        .collect::<Option<Vec<String>>>()?;
    Some(WorkerRecord {
        pid,
        started_at,
        state_dir,
        harness_version,
        argv,
    })
}

fn valid_sync(value: &Value) -> Option<AgentSync> {
    let object = value.as_object()?;
    let state = object.get("state")?.as_str()?;
    if !SYNC_STATES.contains(&state) {
        return None;
    }
    let at = match object.get("at") {
        Some(Value::Null) => None,
        Some(Value::String(text)) => Some(text.clone()),
        _ => return None,
    };
    let error = match object.get("error") {
        Some(Value::Null) => None,
        Some(Value::String(text)) => Some(text.clone()),
        _ => return None,
    };
    Some(AgentSync {
        state: state.to_string(),
        at,
        error,
    })
}

fn nullable_key(object: &Map<String, Value>, key: &str) -> Option<Option<String>> {
    match object.get(key) {
        None | Some(Value::Null) => Some(None),
        Some(Value::String(text)) => Some(Some(text.clone())),
        _ => None,
    }
}

fn valid_repo_issue(value: &Value, family_id: RepoFamilyId) -> Option<Value> {
    let object = value.as_object()?;
    let number = object.get("number")?.as_u64()?;
    if number == 0 {
        return None;
    }
    object.get("title")?.as_str()?;
    object.get("url")?.as_str()?;
    object.get("createdAt")?.as_str()?;
    let state = object.get("state")?.as_str()?;
    if !matches!(state, "pending" | "implemented") {
        return None;
    }
    nullable_key(object, "category")?;
    nullable_key(object, "version")?;
    if matches!(family_id, RepoFamilyId::Scout | RepoFamilyId::DeadCode) {
        nullable_key(object, "versionAttemptAt")?;
        nullable_key(object, "versionError")?;
    }
    Some(value.clone())
}

fn parse_repo_state(family_id: RepoFamilyId, text: &str) -> Option<RepoState> {
    let value: Value = serde_json::from_str(text).ok()?;
    let object = value.as_object()?;
    if object.get("version")?.as_u64()? != family_id.state_version() {
        return None;
    }
    object.get("repo")?.as_str()?;
    object.get("root")?.as_str()?;
    let lifecycle = object.get("lifecycle")?.as_str()?;
    if !family_id.lifecycle_allowed(lifecycle) {
        return None;
    }
    object.get("enabled")?.as_bool()?;
    let worker = match object.get("worker") {
        Some(Value::Null) | None => None,
        Some(value) => Some(valid_worker(value)?),
    };
    let limits_object = object.get("limits")?.as_object()?;
    let max_per_hour = valid_limit(limits_object.get("maxPerHour"))?;
    let max_pending = valid_limit(limits_object.get("maxPending"))?;
    let interval_minutes = match object.get("intervalMinutes") {
        None if family_id == RepoFamilyId::Scout => family_id.default_minutes(),
        Some(value) => valid_cadence(Some(value))?,
        None => return None,
    };
    let last_cycle_key = if family_id == RepoFamilyId::Scout {
        "lastScanStartedAt"
    } else {
        "lastCycleStartedAt"
    };
    let last_cycle_started_at = match object.get(last_cycle_key) {
        None if family_id == RepoFamilyId::Scout => None,
        Some(Value::Null) => None,
        Some(Value::String(text)) => Some(text.clone()),
        _ => return None,
    };
    let issues: Vec<Value> = object
        .get("issues")?
        .as_array()?
        .iter()
        .map(|issue| valid_repo_issue(issue, family_id))
        .collect::<Option<Vec<Value>>>()?;
    let sync = valid_sync(object.get("sync")?)?;
    let newest_key = if family_id == RepoFamilyId::Scout {
        "newestScanId"
    } else {
        "newestCycleId"
    };
    let newest_cycle_id = nullable_key(object, newest_key)?;
    let documentation = match object.get("documentation") {
        None => Vec::new(),
        Some(value) => value.as_array()?.clone(),
    };
    let next_attempt_at = nullable_key(object, "nextAttemptAt")?;
    let last_error = nullable_key(object, "lastError")?;
    let notice = nullable_key(object, "notice")?;
    let draining = match object.get("draining") {
        None => false,
        Some(value) => value.as_bool()?,
    };
    let updated_at = object.get("updatedAt")?.as_str()?.to_string();
    let mut active_cycle_started_at = last_cycle_started_at.clone();
    if family_id == RepoFamilyId::Scout {
        if let Some(scan) = object.get("scan").and_then(Value::as_object) {
            if let Some(started) = scan.get("startedAt").and_then(Value::as_str) {
                active_cycle_started_at = Some(started.to_string());
            }
        }
    }
    Some(RepoState {
        lifecycle: lifecycle.to_string(),
        enabled: object.get("enabled")?.as_bool()?,
        worker,
        limits: Limits {
            max_per_hour,
            max_pending,
        },
        interval_minutes,
        last_cycle_started_at,
        issues,
        sync,
        newest_cycle_id,
        documentation,
        next_attempt_at,
        last_error,
        notice,
        draining,
        updated_at,
        active_cycle_started_at,
    })
}

fn project_repo_issue(family_id: RepoFamilyId, issue: &Value) -> Value {
    let object = issue.as_object();
    let mut row = Map::new();
    row.insert(
        "title".to_string(),
        object
            .and_then(|map| map.get("title"))
            .cloned()
            .unwrap_or(Value::Null),
    );
    row.insert(
        "category".to_string(),
        nullable_text(
            object
                .and_then(|map| map.get("category"))
                .and_then(Value::as_str)
                .map(str::to_string),
        ),
    );
    row.insert(
        "filedAt".to_string(),
        object
            .and_then(|map| map.get("createdAt"))
            .cloned()
            .unwrap_or(Value::Null),
    );
    row.insert(
        "url".to_string(),
        object
            .and_then(|map| map.get("url"))
            .cloned()
            .unwrap_or(Value::Null),
    );
    row.insert(
        "state".to_string(),
        object
            .and_then(|map| map.get("state"))
            .cloned()
            .unwrap_or(Value::Null),
    );
    row.insert(
        "version".to_string(),
        nullable_text(
            object
                .and_then(|map| map.get("version"))
                .and_then(Value::as_str)
                .map(str::to_string),
        ),
    );
    if family_id == RepoFamilyId::DeadCode {
        row.insert(
            "note".to_string(),
            nullable_text(
                object
                    .and_then(|map| map.get("versionError"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
            ),
        );
    }
    Value::Object(row)
}

fn merge_repo_issues(states: &[RepoState]) -> Vec<Value> {
    let mut ordered: Vec<&RepoState> = states.iter().collect();
    ordered.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    let mut seen = HashSet::new();
    let mut rows = Vec::new();
    for state in ordered {
        for issue in &state.issues {
            let url = issue.get("url").and_then(Value::as_str).unwrap_or("");
            let title = issue.get("title").and_then(Value::as_str).unwrap_or("");
            let key = if url.is_empty() { title } else { url };
            if seen.insert(key.to_string()) {
                rows.push(issue.clone());
            }
        }
    }
    rows
}

/// Every issue URL the given states already carry: the forge's read set.
fn forge_urls_of(states: &[RepoState]) -> Vec<String> {
    merge_repo_issues(states)
        .into_iter()
        .filter_map(|issue| issue.get("url").and_then(Value::as_str).map(str::to_string))
        .collect()
}

/// The most recently updated state of one read of the family's tree.
fn current_state_of(states: &[RepoState]) -> Option<RepoState> {
    states
        .iter()
        .max_by(|left, right| left.updated_at.cmp(&right.updated_at))
        .cloned()
}

/// The facts a previous dashboard run already resolved, so a restart reads
/// only the URLs that are still pending or unreadable.
fn seed_forge_facts(family_id: RepoFamilyId, state_dir: &Path, repo_dir: &Path) -> Vec<ForgeFact> {
    let directory = state_dir
        .join(family_id.directory())
        .join(family_id.directory())
        .join(crate::journal::journal_key(repo_dir));
    let mut states = Vec::new();
    if let Ok(text) = std::fs::read_to_string(directory.join("state.json")) {
        if let Some(state) = parse_repo_state(family_id, &text) {
            states.push(state);
        }
    }
    for worker in worker_state_directories(&directory) {
        if let Ok(text) = std::fs::read_to_string(worker.join("state.json")) {
            if let Some(state) = parse_repo_state(family_id, &text) {
                states.push(state);
            }
        }
    }
    merge_repo_issues(&states)
        .into_iter()
        .filter_map(|issue| {
            let url = issue.get("url").and_then(Value::as_str)?.to_string();
            let state = issue.get("state").and_then(Value::as_str)?;
            match state {
                "implemented" => Some(ForgeFact {
                    url,
                    state: "implemented".to_string(),
                    version: issue
                        .get("version")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                }),
                "unknown" => Some(ForgeFact {
                    url,
                    state: "unreadable".to_string(),
                    version: None,
                }),
                _ => None,
            }
        })
        .collect()
}

fn newest_cycle_id(states: &[RepoState]) -> Option<String> {
    let mut newest: Option<String> = None;
    for state in states {
        if let Some(id) = state.newest_cycle_id.as_ref() {
            if newest.as_ref().map(|current| id > current).unwrap_or(true) {
                newest = Some(id.clone());
            }
        }
    }
    newest
}

fn scan_id_of(states: &[RepoState]) -> Option<String> {
    let mut newest_scan: Option<&RepoState> = None;
    for state in states {
        if state.active_cycle_started_at.is_some() || state.lifecycle == "scanning" {
            newest_scan = match newest_scan {
                None => Some(state),
                Some(current) => {
                    let left = state.active_cycle_started_at.as_deref().unwrap_or("");
                    let right = current.active_cycle_started_at.as_deref().unwrap_or("");
                    if left > right {
                        Some(state)
                    } else {
                        Some(current)
                    }
                }
            };
        }
    }
    if let Some(state) = newest_scan {
        if let Some(id) = state.newest_cycle_id.as_ref() {
            return Some(id.clone());
        }
    }
    states
        .iter()
        .filter_map(|state| state.newest_cycle_id.clone())
        .max()
}

fn worker_lifecycle(_family_id: RepoFamilyId, state: Option<&RepoState>) -> String {
    let Some(state) = state else {
        return "running".to_string();
    };
    match state.lifecycle.as_str() {
        "stopped" => "stopped".to_string(),
        "failed" => "failed".to_string(),
        _ if state.draining => "stopping".to_string(),
        _ => "running".to_string(),
    }
}

fn next_cadence_at(last_run_at: Option<&str>, minutes: u32) -> Option<String> {
    let started = parse_millis(last_run_at?)?;
    Some(iso_from_millis(started + i64::from(minutes) * 60_000))
}

struct RepoMutable {
    preview_starting: bool,
    starting: bool,
    starting_since: Option<i64>,
    start_deadline: Option<i64>,
    /// The pid the last Start spawned, while that worker is the one being
    /// waited on. A live process proves the start; the lock proves attachment.
    started_pid: Option<u32>,
    stop_requested: bool,
    start_error: Option<String>,
    notice: Option<String>,
    stopping: HashSet<u32>,
    takeover: bool,
    last_sync_request_at: i64,
    last_activity_cycle: Option<String>,
    last_activity: Vec<String>,
}

struct RepoFamily {
    descriptor: &'static Descriptor,
    family_id: RepoFamilyId,
    repo_dir: PathBuf,
    canonical_repo_dir: PathBuf,
    state_dir: PathBuf,
    agent_command: String,
    running_version: Option<String>,
    environment: HashMap<String, String>,
    spawn: SharedSpawn,
    preflight_override: SharedPreflight,
    preflight_timeout_ms: Arc<AtomicU64>,
    agent_environment: Arc<Mutex<Arc<AgentEnvironment>>>,
    forge: ForgeProjection,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    mutable: Arc<Mutex<RepoMutable>>,
    start_lock: tokio::sync::Mutex<()>,
}

impl RepoFamily {
    #[allow(clippy::too_many_arguments)]
    fn new(
        family_id: RepoFamilyId,
        repo_dir: &Path,
        state_dir: &Path,
        environment: &HashMap<String, String>,
        agent_command: &str,
        running_version: Option<String>,
        agent_environment: Arc<Mutex<Arc<AgentEnvironment>>>,
        spawn: SharedSpawn,
        preflight_override: SharedPreflight,
        forge_reader: Option<ForgeReader>,
        now: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Self {
        let descriptor = match family_id {
            RepoFamilyId::Scout => descriptor("scout"),
            RepoFamilyId::Design => descriptor("design"),
            RepoFamilyId::DeadCode => descriptor("dead-code"),
            RepoFamilyId::ApiStandards => descriptor("api-standards"),
            RepoFamilyId::SingleResponsibility => descriptor("single-responsibility"),
            RepoFamilyId::ConsistentNaming => descriptor("consistent-naming"),
        }
        .expect("a repository family descriptor");
        Self {
            descriptor,
            family_id,
            repo_dir: repo_dir.to_path_buf(),
            canonical_repo_dir: canonical_process_path(repo_dir),
            state_dir: state_dir.to_path_buf(),
            agent_command: agent_command.to_string(),
            running_version,
            environment: environment.clone(),
            spawn,
            preflight_override,
            preflight_timeout_ms: Arc::new(AtomicU64::new(AGENT_PREFLIGHT_TIMEOUT_MS)),
            agent_environment,
            forge: ForgeProjection::new(
                forge_reader,
                seed_forge_facts(family_id, state_dir, repo_dir),
            ),
            now,
            mutable: Arc::new(Mutex::new(RepoMutable {
                preview_starting: false,
                starting: false,
                starting_since: None,
                start_deadline: None,
                started_pid: None,
                stop_requested: false,
                start_error: None,
                notice: None,
                stopping: HashSet::new(),
                takeover: false,
                last_sync_request_at: i64::MIN / 2,
                last_activity_cycle: None,
                last_activity: Vec::new(),
            })),
            start_lock: tokio::sync::Mutex::new(()),
        }
    }

    fn preflight_timeout_cell(&self) -> Arc<AtomicU64> {
        Arc::clone(&self.preflight_timeout_ms)
    }

    fn repo_state_directory(&self) -> PathBuf {
        self.state_dir
            .join(self.family_id.directory())
            .join(crate::journal::journal_key(&self.repo_dir))
    }

    fn legacy_state_path(&self) -> PathBuf {
        self.repo_state_directory().join("state.json")
    }

    fn versioned_state_path(&self, version: Option<&str>) -> PathBuf {
        self.repo_state_directory()
            .join("workers")
            .join(worker_version_key(version))
            .join("state.json")
    }

    fn legacy_control_directory(&self) -> PathBuf {
        self.repo_state_directory().join("control")
    }

    fn versioned_control_directory(&self, version: Option<&str>) -> PathBuf {
        self.repo_state_directory()
            .join("workers")
            .join(worker_version_key(version))
            .join("control")
    }

    fn settings_path(&self) -> PathBuf {
        self.repo_state_directory().join("settings.json")
    }

    fn lock_path(&self) -> PathBuf {
        self.repo_dir
            .join(".devboard")
            .join(".tmp")
            .join(self.family_id.directory())
            .join("lock")
    }

    fn cycle_directory(&self, id: &str) -> PathBuf {
        self.repo_dir
            .join(".devboard")
            .join(".tmp")
            .join(self.family_id.directory())
            .join(self.family_id.cycle_directory())
            .join(id)
    }

    fn all_states(&self) -> Vec<RepoState> {
        #[cfg(test)]
        STATE_TREE_WALKS.with(|walks| walks.set(walks.get() + 1));
        let mut states = Vec::new();
        if let Ok(text) = std::fs::read_to_string(self.legacy_state_path()) {
            if let Some(state) = parse_repo_state(self.family_id, &text) {
                states.push(state);
            }
        }
        for directory in worker_state_directories(&self.repo_state_directory()) {
            if let Ok(text) = std::fs::read_to_string(directory.join("state.json")) {
                if let Some(state) = parse_repo_state(self.family_id, &text) {
                    states.push(state);
                }
            }
        }
        states
    }

    /// The durable state and worker scratch this family's snapshot reads.
    fn poll_signature(&self) -> u64 {
        let scratch = self
            .repo_dir
            .join(".devboard")
            .join(".tmp")
            .join(self.family_id.directory());
        tree_signature(&self.repo_state_directory()) ^ tree_signature(&scratch)
    }

    fn rebuild_always(&self) -> bool {
        let Ok(mutable) = self.mutable.lock() else {
            return true;
        };
        mutable.starting
            || mutable.preview_starting
            || mutable.stop_requested
            || !mutable.stopping.is_empty()
    }

    fn all_owners(&self) -> Vec<LockOwner> {
        live_lock_owners(&self.lock_path())
    }

    /// Whether one live worker was started for this dashboard's state.
    fn owns(&self, owner: &LockOwner) -> bool {
        resolved(Path::new(&owner.state_dir)) == resolved(&self.state_dir)
    }

    fn owned_owners(&self) -> Vec<LockOwner> {
        self.owned_owners_of(&self.all_owners())
    }

    /// The owners this dashboard started, read from one lock-directory scan so
    /// a snapshot that asks twice never re-reads the same directory.
    fn owned_owners_of(&self, owners: &[LockOwner]) -> Vec<LockOwner> {
        owners
            .iter()
            .filter(|owner| self.owns(owner))
            .cloned()
            .collect()
    }

    fn foreign_owner(&self) -> Option<LockOwner> {
        self.foreign_owner_of(&self.all_owners())
    }

    /// The first owner another dashboard started, from that same one scan.
    fn foreign_owner_of(&self, owners: &[LockOwner]) -> Option<LockOwner> {
        owners.iter().find(|owner| !self.owns(owner)).cloned()
    }

    fn control_for(&self, owner: &LockOwner) -> PathBuf {
        if let Some(version) = owner.harness_version.as_deref() {
            if self.family_id == RepoFamilyId::Scout {
                if self.versioned_state_path(Some(version)).exists() {
                    return self.versioned_control_directory(Some(version));
                }
                return self.legacy_control_directory();
            }
            return self.versioned_control_directory(Some(version));
        }
        self.legacy_control_directory()
    }

    fn state_for_owner(&self, owner: &LockOwner) -> Option<RepoState> {
        if let Some(version) = owner.harness_version.as_deref() {
            if let Ok(text) = std::fs::read_to_string(self.versioned_state_path(Some(version))) {
                if let Some(state) = parse_repo_state(self.family_id, &text) {
                    return Some(state);
                }
            }
        }
        let text = std::fs::read_to_string(self.legacy_state_path()).ok()?;
        parse_repo_state(self.family_id, &text)
    }

    fn settings(&self, state: Option<&RepoState>) -> BasicSettings {
        read_basic_settings(&self.settings_path()).unwrap_or_else(|| {
            let defaults = BasicSettings {
                interval_minutes: self.family_id.default_minutes(),
                max_per_hour: self.family_id.default_limits().max_per_hour,
                max_pending: self.family_id.default_limits().max_pending,
            };
            match state {
                Some(state) => BasicSettings {
                    interval_minutes: state.interval_minutes,
                    max_per_hour: state.limits.max_per_hour,
                    max_pending: state.limits.max_pending,
                },
                None => defaults,
            }
        })
    }

    fn snapshot(&self) -> Value {
        let now = (self.now)();
        // One read of the family's state tree answers the forge URLs and the
        // projection it feeds: a Start's answer walks that tree once, never
        // once per question.
        let states = self.all_states();
        if self.family_id.uses_forge() && forge_urls_of(&states).is_empty() {
            self.forge.note_empty_read(now);
        }
        let all_owners = self.all_owners();
        let owners = self.owned_owners_of(&all_owners);
        let foreign = self.foreign_owner_of(&all_owners);
        let by_pid: HashMap<u32, RepoState> = states
            .iter()
            .filter_map(|state| {
                state
                    .worker
                    .as_ref()
                    .map(|worker| (worker.pid, state.clone()))
            })
            .collect();
        let mut attached_owners: Vec<LockOwner> = owners
            .iter()
            .filter(|owner| pid_alive(owner.pid))
            .cloned()
            .collect();
        if self.family_id == RepoFamilyId::Scout {
            attached_owners = owners.clone();
        }
        let attached_states: Vec<RepoState> = attached_owners
            .iter()
            .filter_map(|owner| {
                by_pid
                    .get(&owner.pid)
                    .cloned()
                    .or_else(|| self.state_for_owner(owner))
            })
            .collect();
        let attached = !attached_owners.is_empty();
        let mut sorted = states.clone();
        sorted.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        let active: Option<RepoState> = if self.family_id == RepoFamilyId::Scout {
            attached_states
                .iter()
                .find(|state| state.lifecycle == "scanning")
                .cloned()
                .or_else(|| attached_states.first().cloned())
        } else {
            attached_states
                .iter()
                .find(|state| {
                    state.lifecycle == self.family_id.active_lifecycle()
                        || (self.family_id == RepoFamilyId::Design
                            && state.lifecycle == "releasing")
                })
                .cloned()
                .or_else(|| {
                    attached_states
                        .iter()
                        .max_by(|left, right| left.updated_at.cmp(&right.updated_at))
                        .cloned()
                })
                .or_else(|| {
                    if attached {
                        None
                    } else {
                        sorted.first().cloned()
                    }
                })
        };
        {
            let Ok(mut mutable) = self.mutable.lock() else {
                return project_snapshot(self.descriptor, empty_repo_input(self.descriptor));
            };
            if (mutable.starting || mutable.preview_starting) && !owners.is_empty() {
                // A worker is attached, so the start this preview announced has
                // happened: the preview never outlives its own Start.
                mutable.starting = false;
                mutable.starting_since = None;
                mutable.start_deadline = None;
                mutable.preview_starting = false;
            }
            if !owners.is_empty() {
                mutable.start_error = None;
            }
            if mutable.starting
                && mutable
                    .start_deadline
                    .is_some_and(|deadline| now > deadline)
            {
                mutable.starting = false;
                mutable.starting_since = None;
                mutable.start_deadline = None;
                mutable.preview_starting = false;
                mutable.start_error = Some(format!(
                    "the {} start did not finish; press Start to retry.",
                    self.descriptor.label
                ));
            }
            if mutable.starting && !mutable.started_pid.is_some_and(pid_alive) {
                if let Some(since) = mutable.starting_since {
                    if now - since > START_PROOF_MS {
                        mutable.starting = false;
                        mutable.starting_since = None;
                        mutable.start_error = Some(format!(
                            "the {} worker did not publish its state within 5 seconds",
                            self.family_id.worker_label()
                        ));
                    }
                }
            }
            if mutable.stop_requested && attached_owners.is_empty() {
                mutable.stop_requested = false;
            }
            if let Some(foreign) = foreign.as_ref() {
                if !mutable.notice.as_deref().is_some_and(is_start_refusal) {
                    mutable.notice = Some(format!(
                        "this checkout already has a {} worker (pid {}) using {}; this dashboard's STATE_DIR is {}",
                        self.family_id.worker_label(),
                        foreign.pid,
                        foreign.state_dir,
                        self.state_dir.display()
                    ));
                }
            } else if mutable
                .notice
                .as_ref()
                .map(|notice| {
                    notice.starts_with("this checkout already has")
                        || notice.starts_with("Start did nothing: this checkout already has")
                })
                .unwrap_or(false)
            {
                mutable.notice = None;
            }
            // A refusal that named a running worker or a starting one stops
            // applying once that condition is gone.
            if owners.is_empty()
                && !mutable.starting
                && !mutable.preview_starting
                && mutable
                    .notice
                    .as_deref()
                    .is_some_and(|notice| notice.starts_with("Start did nothing: the "))
            {
                mutable.notice = None;
            }
        }
        let mutable = self.mutable.lock().expect("family state");
        let scanning = attached_states
            .iter()
            .any(|state| state.lifecycle == self.family_id.active_lifecycle());
        let failed = attached_states
            .iter()
            .any(|state| state.lifecycle == "failed");
        let stopped = !attached_states.is_empty()
            && attached_states
                .iter()
                .all(|state| state.lifecycle == "stopped");
        let state = current_state_of(&states);
        let lifecycle = if mutable.starting || mutable.preview_starting {
            "starting".to_string()
        } else if mutable.stop_requested {
            "stopping".to_string()
        } else if attached {
            if self.family_id == RepoFamilyId::Scout {
                if scanning {
                    "running".to_string()
                } else if failed {
                    "failed".to_string()
                } else if stopped {
                    "stopped".to_string()
                } else {
                    "running".to_string()
                }
            } else if active
                .as_ref()
                .map(|state| state.lifecycle == "failed")
                .unwrap_or(false)
            {
                "failed".to_string()
            } else if active
                .as_ref()
                .map(|state| state.lifecycle == "stopped")
                .unwrap_or(false)
            {
                "stopped".to_string()
            } else {
                "running".to_string()
            }
        } else if !all_owners.is_empty() {
            "running".to_string()
        } else if state
            .as_ref()
            .map(|state| state.lifecycle == "failed" && state.enabled)
            .unwrap_or(false)
        {
            "failed".to_string()
        } else {
            "stopped".to_string()
        };
        let settings = self.settings(active.as_ref().or(state.as_ref()));
        let last_run_at = if self.family_id == RepoFamilyId::Scout {
            let mut candidates: Vec<String> = attached_states
                .iter()
                .filter_map(|state| state.last_cycle_started_at.clone())
                .collect();
            candidates.sort();
            candidates.last().cloned().or_else(|| {
                state
                    .as_ref()
                    .and_then(|state| state.last_cycle_started_at.clone())
                    .or_else(|| {
                        active
                            .as_ref()
                            .and_then(|active| active.active_cycle_started_at.clone())
                    })
            })
        } else {
            let mut candidates: Vec<String> = states
                .iter()
                .filter_map(|state| state.last_cycle_started_at.clone())
                .collect();
            candidates.sort();
            candidates.last().cloned()
        };
        let next_run_at = if attached {
            if self.family_id == RepoFamilyId::Scout {
                active
                    .as_ref()
                    .and_then(|state| state.next_attempt_at.clone())
                    .or_else(|| next_cadence_at(last_run_at.as_deref(), settings.interval_minutes))
            } else {
                active
                    .as_ref()
                    .and_then(|state| state.next_attempt_at.clone())
            }
        } else {
            None
        };
        let rows: Vec<Value> = merge_repo_issues(&states)
            .into_iter()
            .filter(|issue| {
                let url = issue.get("url").and_then(Value::as_str).unwrap_or("");
                self.forge.reported(url)
            })
            .map(|issue| {
                let url = issue.get("url").and_then(Value::as_str).unwrap_or("");
                if self.family_id.uses_forge() {
                    if let Some(fact) = self.forge.fact(url) {
                        let mut row = project_repo_issue(self.family_id, &issue);
                        if let Some(object) = row.as_object_mut() {
                            object.insert("state".to_string(), Value::String(fact.state));
                            object
                                .insert("version".to_string(), nullable_text(fact.version.clone()));
                            if self.family_id == RepoFamilyId::DeadCode {
                                let note = if fact.version.is_none() {
                                    issue
                                        .get("versionError")
                                        .and_then(Value::as_str)
                                        .map(str::to_string)
                                } else {
                                    None
                                };
                                object.insert("note".to_string(), nullable_text(note));
                            }
                        }
                        return row;
                    }
                    if self.forge.unreadable(url)
                        && matches!(
                            self.family_id,
                            RepoFamilyId::Scout | RepoFamilyId::Design | RepoFamilyId::DeadCode
                        )
                    {
                        let mut row = project_repo_issue(self.family_id, &issue);
                        if let Some(object) = row.as_object_mut() {
                            object
                                .insert("state".to_string(), Value::String("unknown".to_string()));
                        }
                        return row;
                    }
                }
                project_repo_issue(self.family_id, &issue)
            })
            .collect();
        let cycle_id = if self.family_id == RepoFamilyId::Scout {
            scan_id_of(&states)
        } else {
            newest_cycle_id(&states)
        };
        let workers: Vec<Worker> = attached_owners
            .iter()
            .map(|owner| {
                let state = by_pid
                    .get(&owner.pid)
                    .cloned()
                    .or_else(|| self.state_for_owner(owner));
                Worker {
                    pid: owner.pid,
                    version: owner.harness_version.clone(),
                    state_dir: owner.state_dir.clone(),
                    lifecycle: worker_lifecycle(self.family_id, state.as_ref()),
                }
            })
            .collect();
        let enabled = if self.family_id == RepoFamilyId::Scout {
            attached && attached_states.iter().any(|state| state.enabled) && lifecycle != "stopped"
        } else {
            attached
                && active.as_ref().map(|state| state.enabled).unwrap_or(false)
                && lifecycle != "stopped"
        };
        let sync = if self.family_id.uses_forge() {
            self.forge.sync(now)
        } else {
            active
                .as_ref()
                .map(|state| state.sync.clone())
                .unwrap_or_else(AgentSync::stale)
        };
        let pending = rows
            .iter()
            .filter(|row| row.get("state").and_then(Value::as_str) == Some("pending"))
            .count() as u64;
        let documentation = if self.family_id == RepoFamilyId::Design {
            merge_documentation(&states)
        } else {
            Vec::new()
        };
        project_snapshot(
            self.descriptor,
            SnapshotInput {
                lifecycle,
                paused: false,
                enabled,
                owned: attached,
                attached,
                minutes: settings.interval_minutes,
                last_run_at,
                next_run_at,
                limits: Limits {
                    max_per_hour: settings.max_per_hour,
                    max_pending: settings.max_pending,
                },
                issues: rows,
                documentation,
                releases: Vec::new(),
                pending,
                sync,
                detail: Detail::Activity {
                    scan_id: cycle_id,
                    entries: mutable.last_activity.clone(),
                },
                notice: mutable
                    .notice
                    .clone()
                    .or_else(|| active.as_ref().and_then(|state| state.notice.clone())),
                error: mutable
                    .start_error
                    .clone()
                    .or_else(|| active.as_ref().and_then(|state| state.last_error.clone())),
                timer: None,
                workers,
            },
        )
    }

    fn forge_urls(&self) -> Vec<String> {
        forge_urls_of(&self.all_states())
    }

    fn replay(&self, conn: &Conn, shared: &Shared, snapshot: Value) {
        let mut frame = Map::new();
        frame.insert("type".to_string(), Value::String("agentState".to_string()));
        frame.insert("agent".to_string(), snapshot);
        conn.send(Value::Object(frame));
        let cycle_id = self
            .mutable
            .lock()
            .ok()
            .and_then(|mutable| mutable.last_activity_cycle.clone())
            .or_else(|| {
                let states = self.all_states();
                if self.family_id == RepoFamilyId::Scout {
                    scan_id_of(&states)
                } else {
                    newest_cycle_id(&states)
                }
            });
        let Some(cycle_id) = cycle_id else {
            return;
        };
        let activity = read_activity(&self.cycle_directory(&cycle_id));
        if let Ok(mut mutable) = self.mutable.lock() {
            mutable.last_activity_cycle = Some(cycle_id.clone());
            mutable.last_activity = activity.clone();
        }
        let event = json!({
            "type": "agentActivity",
            "id": self.descriptor.id,
            "scanId": cycle_id,
            "replay": true,
            "entries": activity.iter().map(|text| json!({"text": text, "append": false})).collect::<Vec<Value>>(),
        });
        conn.send(event.clone());
        shared.send_all(event, Some(conn.id()));
    }

    fn poll_activity(&self, shared: &Shared) {
        let states = self.all_states();
        let cycle_id = if self.family_id == RepoFamilyId::Scout {
            scan_id_of(&states)
        } else {
            newest_cycle_id(&states)
        };
        let Some(cycle_id) = cycle_id else {
            if let Ok(mut mutable) = self.mutable.lock() {
                mutable.last_activity_cycle = None;
                mutable.last_activity.clear();
            }
            return;
        };
        let activity = read_activity(&self.cycle_directory(&cycle_id));
        let mut previous = None;
        let mut is_new = false;
        if let Ok(mut mutable) = self.mutable.lock() {
            if mutable.last_activity_cycle.as_deref() != Some(cycle_id.as_str()) {
                is_new = true;
            } else {
                previous = Some(mutable.last_activity.clone());
            }
            mutable.last_activity_cycle = Some(cycle_id.clone());
            mutable.last_activity = activity.clone();
        }
        if is_new {
            let event = json!({
                "type": "agentActivity",
                "id": self.descriptor.id,
                "scanId": cycle_id,
                "replay": true,
                "entries": activity.iter().map(|text| json!({"text": text, "append": false})).collect::<Vec<Value>>(),
            });
            shared.send_all(event, None);
            return;
        }
        let delta = crate::activity::activity_delta(&previous.unwrap_or_default(), &activity);
        if !delta.replay && delta.entries.is_empty() {
            return;
        }
        let mut event = Map::new();
        event.insert(
            "type".to_string(),
            Value::String("agentActivity".to_string()),
        );
        event.insert(
            "id".to_string(),
            Value::String(self.descriptor.id.to_string()),
        );
        event.insert("scanId".to_string(), Value::String(cycle_id));
        if delta.replay {
            event.insert("replay".to_string(), Value::Bool(true));
        }
        event.insert(
            "entries".to_string(),
            Value::Array(delta.entries.iter().map(|entry| entry.to_json()).collect()),
        );
        shared.send_all(Value::Object(event), None);
    }

    fn request_sync(&self) {
        if self.family_id.uses_forge() {
            self.forge.request_sync_only();
        }
        if !self.family_id.refreshes_worker() {
            return;
        }
        let owners = self.owned_owners();
        if owners.is_empty() {
            return;
        }
        let now = (self.now)();
        if let Ok(mut mutable) = self.mutable.lock() {
            if now - mutable.last_sync_request_at < SYNC_REQUEST_MIN_INTERVAL_MS {
                return;
            }
            mutable.last_sync_request_at = now;
        }
        for owner in owners {
            let _ = write_command(&self.control_for(&owner), &json!({"type": "refresh"}));
        }
    }

    async fn takeover(&self) {
        {
            let Ok(mut mutable) = self.mutable.lock() else {
                return;
            };
            if mutable.takeover {
                return;
            }
            mutable.takeover = true;
        }
        let owners = self.owned_owners();
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
        let started = self.spawn_worker().await;
        if !started.ok {
            return;
        }
        for owner in owners {
            if owner.harness_version == self.running_version {
                continue;
            }
            let _ = write_command(&self.control_for(&owner), &json!({"type": "drain"}));
        }
    }

    fn preview_start(&self) {
        let idle = if self.family_id == RepoFamilyId::Scout {
            self.owned_owners().is_empty()
        } else {
            self.all_owners().is_empty()
        };
        if idle {
            if let Ok(mut mutable) = self.mutable.lock() {
                mutable.preview_starting = true;
                mutable.start_error = None;
                mutable.notice = None;
            }
        }
    }

    fn clear_preview(&self) {
        if let Ok(mut mutable) = self.mutable.lock() {
            mutable.preview_starting = false;
        }
    }

    async fn start(&self) -> AgentResult {
        let _guard = self.start_lock.lock().await;
        {
            // A Start's own preview is not a spawn: a second command must say
            // that the family is already starting instead of running a second
            // preflight and a second worker.
            let mut mutable = self.mutable.lock().expect("family state");
            if mutable.starting {
                mutable.notice = Some(format!(
                    "Start did nothing: the {} worker is already starting for this dashboard.",
                    self.family_id.worker_label()
                ));
                return AgentResult::ok();
            }
        }
        for _ in 0..1000 {
            let owners = if self.family_id == RepoFamilyId::Scout {
                self.owned_owners()
            } else {
                self.all_owners()
            };
            if owners.is_empty() {
                if let Some(foreign) = self.foreign_owner() {
                    let notice = format!(
                        "Start did nothing: this checkout already has a {} worker (pid {}) using {}; this dashboard's STATE_DIR is {}",
                        self.family_id.worker_label(),
                        foreign.pid,
                        foreign.state_dir,
                        self.state_dir.display()
                    );
                    if let Ok(mut mutable) = self.mutable.lock() {
                        mutable.notice = Some(notice);
                    }
                    return AgentResult::ok();
                }
                break;
            }
            let foreign = owners
                .iter()
                .find(|owner| resolved(Path::new(&owner.state_dir)) != resolved(&self.state_dir));
            if self.family_id != RepoFamilyId::Scout {
                if let Some(foreign) = foreign {
                    let notice = format!(
                        "Start did nothing: this checkout already has a {} worker (pid {}) using {}; this dashboard's STATE_DIR is {}",
                        self.family_id.worker_label(),
                        foreign.pid,
                        foreign.state_dir,
                        self.state_dir.display()
                    );
                    if let Ok(mut mutable) = self.mutable.lock() {
                        mutable.notice = Some(notice);
                    }
                    return AgentResult::ok();
                }
            }
            let stopping: Vec<u32> = {
                let mutable = self.mutable.lock().expect("family state");
                owners
                    .iter()
                    .map(|owner| owner.pid)
                    .filter(|pid| mutable.stopping.contains(pid))
                    .collect()
            };
            if stopping.is_empty() {
                let notice = format!(
                    "Start did nothing: the {} worker (pid {}) is already running for this dashboard.",
                    self.family_id.worker_label(),
                    owners
                        .iter()
                        .map(|owner| owner.pid.to_string())
                        .collect::<Vec<String>>()
                        .join(", ")
                );
                if let Ok(mut mutable) = self.mutable.lock() {
                    mutable.notice = Some(notice);
                }
                return AgentResult::ok();
            }
            let mut all_stopped = true;
            for pid in &stopping {
                if !self.wait_for_stop(*pid).await {
                    all_stopped = false;
                }
            }
            if !all_stopped {
                return AgentResult::failure(format!(
                    "the previous {} worker (pid {}) is still stopping; press Start once it has exited.",
                    self.family_id.worker_label(),
                    stopping
                        .iter()
                        .map(u32::to_string)
                        .collect::<Vec<String>>()
                        .join(", ")
                ));
            }
        }
        {
            let mut mutable = self.mutable.lock().expect("family state");
            mutable.starting = true;
            mutable.starting_since = None;
            mutable.start_deadline = Some(start_deadline_at(
                (self.now)(),
                self.preflight_timeout_ms.load(Ordering::SeqCst).max(1),
            ));
            mutable.started_pid = None;
            mutable.start_error = None;
            mutable.notice = None;
        }
        let request = PreflightRequest {
            family: self.family_id.directory().to_string(),
            repo_dir: self.repo_dir.clone(),
            state_dir: self.state_dir.clone(),
            environment: self.environment.clone(),
        };
        let override_preflight = self
            .preflight_override
            .lock()
            .ok()
            .and_then(|slot| slot.clone());
        let timeout_ms = self.preflight_timeout_ms.load(Ordering::SeqCst).max(1);
        let budget = PreflightBudget::new(timeout_ms);
        let pending: Pin<Box<dyn Future<Output = Result<String, String>> + Send>> =
            match override_preflight {
                Some(callback) => callback(request),
                None => Box::pin(self.real_preflight(budget)),
            };
        let result =
            match crate::deadline::within_deadline(pending, timeout_ms + PREFLIGHT_BUDGET_GRACE_MS)
                .await
            {
                Some(result) => result,
                None => Err(format!(
                "the start preflight did not finish within {timeout_ms} ms; press Start to retry."
            )),
            };
        match result {
            Ok(_) => self.spawn_worker().await,
            Err(message) => {
                let mut mutable = self.mutable.lock().expect("family state");
                mutable.starting = false;
                mutable.starting_since = None;
                let (start_error, notice) = start_refusal_fields(message.clone());
                mutable.start_error = start_error;
                mutable.notice = notice;
                AgentResult::failure(message)
            }
        }
    }

    async fn wait_for_stop(&self, pid: u32) -> bool {
        let deadline = (self.now)() + STOP_DEADLINE_MS as i64;
        while pid_alive(pid) && (self.now)() < deadline {
            tokio::time::sleep(Duration::from_millis(STOP_POLL_MS)).await;
        }
        !pid_alive(pid)
    }

    async fn spawn_worker(&self) -> AgentResult {
        let argv = harness_argv(
            self.family_id.directory(),
            &[
                ("repo", self.repo_dir.as_path()),
                ("state-dir", self.state_dir.as_path()),
            ],
        );
        let selection = self
            .agent_environment
            .lock()
            .map(|slot| Arc::clone(&slot))
            .map_err(|_| "the provider selection is unavailable".to_string());
        let base = match selection {
            Ok(selection) => selection().await,
            Err(message) => Err(message),
        };
        let base = match base {
            Ok(base) => base,
            Err(message) => {
                let mut mutable = self.mutable.lock().expect("family state");
                mutable.starting = false;
                mutable.starting_since = None;
                mutable.start_error = Some(message.clone());
                return AgentResult::failure(message);
            }
        };
        let environment = provider_environment(
            &base,
            &[
                ("REPO_DIR", self.repo_dir.to_string_lossy().as_ref()),
                ("STATE_DIR", self.state_dir.to_string_lossy().as_ref()),
                ("AGENT_COMMAND", self.agent_command.as_str()),
            ],
        );
        let spawn = self.spawn.lock().map(|slot| slot.clone()).ok();
        let pid = spawn.and_then(|spawn| spawn(&argv, environment));
        match pid {
            Some(spawn_pid) => {
                // The proof clock starts when the worker exists, never at the
                // request: a forge preflight that reads the repository and
                // ensures its labels outlasts the five second window. The live
                // pid is the proof; the lock only proves attachment.
                let mut mutable = self.mutable.lock().expect("family state");
                mutable.starting = true;
                mutable.started_pid = Some(spawn_pid);
                mutable.starting_since = Some((self.now)());
                mutable.start_deadline = None;
                AgentResult::ok()
            }
            None => {
                let message = format!(
                    "the {} worker could not be started",
                    self.family_id.worker_label()
                );
                let mut mutable = self.mutable.lock().expect("family state");
                mutable.starting = false;
                mutable.starting_since = None;
                mutable.start_error = Some(message.clone());
                AgentResult::failure(message)
            }
        }
    }

    fn stop(&self) -> AgentResult {
        let owners = if self.family_id == RepoFamilyId::Scout {
            self.owned_owners()
        } else {
            self.all_owners()
        };
        if owners.is_empty() {
            if self.family_id == RepoFamilyId::Scout {
                if let Some(foreign) = self.foreign_owner() {
                    return AgentResult::failure(format!(
                        "the Auto Scout worker (pid {}) uses {}; this dashboard's STATE_DIR is {}",
                        foreign.pid,
                        foreign.state_dir,
                        self.state_dir.display()
                    ));
                }
            }
            return AgentResult::failure(format!(
                "No {} worker is running for this checkout.",
                self.family_id.worker_label()
            ));
        }
        if let Some(foreign) = owners
            .iter()
            .find(|owner| resolved(Path::new(&owner.state_dir)) != resolved(&self.state_dir))
        {
            return AgentResult::failure(format!(
                "the {} worker (pid {}) uses {}; this dashboard's STATE_DIR is {}",
                self.family_id.worker_label(),
                foreign.pid,
                foreign.state_dir,
                self.state_dir.display()
            ));
        }
        for owner in &owners {
            if let Err(error) = write_command(&self.control_for(owner), &json!({"type": "stop"})) {
                return AgentResult::failure(format!("Could not reach the worker: {error}"));
            }
        }
        {
            let mut mutable = self.mutable.lock().expect("family state");
            mutable.stop_requested = true;
            mutable.start_error = None;
            mutable.notice = None;
        }
        for owner in owners {
            self.schedule_stop_proof(owner.pid);
        }
        AgentResult::ok()
    }

    fn schedule_stop_proof(&self, pid: u32) {
        {
            let mut mutable = self.mutable.lock().expect("family state");
            if !mutable.stopping.insert(pid) {
                return;
            }
        }
        let repo_dir = self.repo_dir.clone();
        let canonical = self.canonical_repo_dir.clone();
        let family_id = self.family_id;
        let mutable = Arc::clone(&self.mutable);
        let mut state_paths = vec![self.legacy_state_path()];
        for directory in worker_state_directories(&self.repo_state_directory()) {
            state_paths.push(directory.join("state.json"));
        }
        let async_proof = async move {
            loop {
                tokio::time::sleep(Duration::from_millis(STOP_PROOF_MS)).await;
                if !still_stopping(&mutable, pid) {
                    return;
                }
                if !pid_alive(pid) || !proves_worker(pid, family_id, &repo_dir, &canonical) {
                    clear_stopping(&mutable, pid);
                    return;
                }
                if family_id == RepoFamilyId::Design && design_is_releasing(&state_paths, pid) {
                    continue;
                }
                unsafe {
                    libc::kill(pid as i32, libc::SIGTERM);
                }
                tokio::time::sleep(Duration::from_millis(STOP_KILL_GRACE_MS)).await;
                if !still_stopping(&mutable, pid) {
                    return;
                }
                if !pid_alive(pid) || !proves_worker(pid, family_id, &repo_dir, &canonical) {
                    clear_stopping(&mutable, pid);
                    return;
                }
                if family_id == RepoFamilyId::Design && design_is_releasing(&state_paths, pid) {
                    continue;
                }
                clear_stopping(&mutable, pid);
                unsafe {
                    libc::kill(pid as i32, libc::SIGKILL);
                }
                return;
            }
        };
        tokio::spawn(async_proof);
    }

    fn set_settings(
        &self,
        minutes: Option<u64>,
        max_per_hour: Option<Value>,
        max_pending: Option<Value>,
    ) -> AgentResult {
        let Some(minutes) = minutes.filter(|value| (1..=1440).contains(value)) else {
            return AgentResult::failure(
                "The cadence must be an integer from 1 through 1440 minutes.".to_string(),
            );
        };
        let Some(max_per_hour) = strict_limit(&max_per_hour) else {
            return AgentResult::failure(
                "Both limits must be empty or integers from 1 through 100.".to_string(),
            );
        };
        let Some(max_pending) = strict_limit(&max_pending) else {
            return AgentResult::failure(
                "Both limits must be empty or integers from 1 through 100.".to_string(),
            );
        };
        let settings = BasicSettings {
            interval_minutes: minutes as u32,
            max_per_hour,
            max_pending,
        };
        if let Err(error) = write_settings_atomically(&self.settings_path(), &settings.to_json()) {
            return AgentResult::failure(format!("Could not save the settings: {error}"));
        }
        for owner in self.owned_owners() {
            if let Err(error) = write_command(
                &self.control_for(&owner),
                &json!({
                    "type": "settings",
                    "intervalMinutes": minutes,
                    "maxPerHour": max_per_hour,
                    "maxPending": max_pending,
                }),
            ) {
                return AgentResult::failure(format!("Could not reach the worker: {error}"));
            }
        }
        if let Ok(mut mutable) = self.mutable.lock() {
            mutable.start_error = None;
        }
        AgentResult::ok()
    }

    async fn real_preflight(&self, budget: PreflightBudget) -> Result<String, String> {
        match self.family_id {
            RepoFamilyId::Scout => self.preflight_scout(budget).await,
            RepoFamilyId::Design => self.preflight_design(budget).await,
            RepoFamilyId::DeadCode => self.preflight_dead_code(budget).await,
            RepoFamilyId::ApiStandards => self.preflight_api_standards(budget).await,
            RepoFamilyId::SingleResponsibility => {
                self.preflight_single_responsibility(budget).await
            }
            RepoFamilyId::ConsistentNaming => self.preflight_consistent_naming(budget).await,
        }
    }

    fn origin(&self) -> Result<ForgeRemote, String> {
        if let Some(problem) = root_problem(&self.repo_dir) {
            return Err(problem);
        }
        let remote = origin_forge(&self.repo_dir, &self.environment).ok_or_else(|| {
            "the checkout's origin does not name a supported repository".to_string()
        })?;
        if remote.forge == "gitlab" {
            return Err(format!(
                "{} supports a GitHub or Gitea origin, not a GitLab one: {}",
                match self.family_id {
                    RepoFamilyId::Scout => "the scout",
                    RepoFamilyId::DeadCode => "the dead-code agent",
                    RepoFamilyId::ApiStandards => "the API Standards agent",
                    RepoFamilyId::SingleResponsibility => "the Single Responsibility agent",
                    RepoFamilyId::ConsistentNaming => "the Consistent Naming agent",
                    RepoFamilyId::Design => "the design agent",
                },
                remote.host
            ));
        }
        Ok(remote)
    }

    fn require_path(&self, name: &str) -> Result<(), String> {
        if find_on_path(name, &self.environment).is_none() {
            return Err(format!("missing prerequisite: {name} is not on PATH"));
        }
        Ok(())
    }

    fn require_installed_command(&self, command: &str) -> Result<(), String> {
        self.require_path("omp")?;
        let paths = command_paths(&self.repo_dir, &self.environment, command);
        if !paths.iter().any(|path| path.exists()) {
            return Err(format!(
                "missing prerequisite: the /{command} command is not installed for omp (looked in {})",
                paths.iter().map(|path| path.display().to_string()).collect::<Vec<String>>().join(", ")
            ));
        }
        Ok(())
    }

    async fn forge_write_access(
        &self,
        remote: &ForgeRemote,
        budget: PreflightBudget,
    ) -> Result<(), String> {
        if remote.forge == "gitea" {
            let (target, base_url) = gitea_preflight_target(remote, &self.environment)?;
            let transport = crate::forge::default_transport(budget.remaining_ms());
            let document = gitea_repository_within(budget, &target, &transport).await?;
            let permissions = document.get("permissions").cloned().unwrap_or(Value::Null);
            let writable = permissions.get("push").and_then(Value::as_bool) == Some(true)
                || permissions.get("admin").and_then(Value::as_bool) == Some(true);
            if !writable {
                return Err(format!(
                    "missing prerequisite: the Gitea token cannot write to {} on {base_url}",
                    remote.project
                ));
            }
            return Ok(());
        }
        self.require_path("gh")?;
        let permission = gh_command(
            &self.environment,
            &[
                "api",
                &format!("repos/{}", remote.project),
                "--jq",
                ".permissions.push",
            ],
            Some(budget.remaining_ms()),
        )
        .await?;
        if permission.code != 0 || permission.stdout.trim() != "true" {
            let detail = first_line(&permission.stderr)
                .or_else(|| first_line(&permission.stdout))
                .unwrap_or_else(|| format!("gh exited with code {}", permission.code));
            return Err(format!(
                "missing prerequisite: 'gh api repos/{} --jq .permissions.push' did not return true: {detail}",
                remote.project
            ));
        }
        Ok(())
    }

    async fn ensure_label(
        &self,
        remote: &ForgeRemote,
        label: &str,
        color: &str,
        description: &str,
        budget: PreflightBudget,
    ) -> Result<(), String> {
        if remote.forge == "gitea" {
            let (target, _) = gitea_preflight_target(remote, &self.environment)?;
            let transport = crate::forge::default_transport(budget.remaining_ms());
            let labels = gitea_labels_within(budget, &target, &transport).await?;
            if labels.iter().any(|entry| entry.name == label) {
                return Ok(());
            }
            let created = {
                let call = crate::forge::GiteaCallOptions {
                    flow_id: None,
                    timeout_ms: Some(budget.request_ms()),
                };
                budget
                    .run(&format!("creating the \"{label}\" label"), async {
                        crate::forge::gitea_create_label(
                            &target,
                            label,
                            color,
                            description,
                            &transport,
                            &call,
                        )
                        .await
                        .map(|entry| entry.id)
                        .map_err(|error| error.message)
                    })
                    .await
            };
            if created.is_ok() {
                return Ok(());
            }
            let after = gitea_labels_within(budget, &target, &transport).await?;
            if after.iter().any(|entry| entry.name == label) {
                return Ok(());
            }
            return Err(format!(
                "missing prerequisite: the \"{label}\" label could not be created in {}: {}",
                remote.project,
                created.err().unwrap_or_default()
            ));
        }
        let label_read = gh_command(
            &self.environment,
            &[
                "api",
                &format!("repos/{}/labels/{label}", remote.project),
                "--jq",
                ".name",
            ],
            Some(budget.remaining_ms()),
        )
        .await?;
        if label_read.code == 0 && label_read.stdout.trim() == label {
            return Ok(());
        }
        let created = gh_command(
            &self.environment,
            &[
                "label",
                "create",
                label,
                "--repo",
                &remote.project,
                "--color",
                color,
                "--description",
                description,
                "--force",
            ],
            Some(budget.remaining_ms()),
        )
        .await?;
        if created.code != 0 {
            return Err(format!(
                "missing prerequisite: the \"{label}\" label could not be created in {}: {}",
                remote.project,
                first_line(&created.stderr)
                    .unwrap_or_else(|| format!("gh exited with code {}", created.code))
            ));
        }
        Ok(())
    }

    async fn preflight_scout(&self, budget: PreflightBudget) -> Result<String, String> {
        let remote = self.origin()?;
        if !state_inside_repository(&self.repo_dir, &self.state_dir) {
            return Err(format!(
                "STATE_DIR {} is not inside REPO_DIR {}; the scout keeps its state beside the checkout",
                self.state_dir.display(),
                self.repo_dir.display()
            ));
        }
        self.require_installed_command("scout-recommendations")?;
        self.forge_write_access(&remote, budget).await?;
        Ok(remote.project)
    }

    async fn preflight_design(&self, budget: PreflightBudget) -> Result<String, String> {
        let source_dir = self
            .environment
            .get("DESIGN_SOURCE_DIR")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| ".devboard/client".to_string());
        let design_document = self
            .environment
            .get("DESIGN_DOCUMENT")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "DESIGN.md".to_string());
        let token_document = self
            .environment
            .get("DESIGN_TOKEN_DOCUMENT")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "design/tokens.json".to_string());
        if !self.repo_dir.join(&source_dir).exists() {
            return Err(format!(
                "missing prerequisite: the canonical harness source checkout has no {source_dir} directory (an installed npm prefix is refused)"
            ));
        }
        let index_candidates = [
            self.repo_dir.join(&source_dir).join("index.html"),
            self.repo_dir
                .join(&source_dir)
                .join("..")
                .join("index.html"),
        ];
        if !index_candidates.iter().any(|candidate| candidate.exists()) {
            return Err(format!(
                "missing prerequisite: {source_dir} has no index.html entry"
            ));
        }
        for document in [&design_document, &token_document] {
            if !self.repo_dir.join(document).exists() {
                return Err(format!("missing prerequisite: {document} is missing"));
            }
        }
        if !inside(&self.repo_dir, &self.state_dir) {
            return Err(format!(
                "STATE_DIR {} is not inside REPO_DIR {}; the design worker keeps its state beside the checkout",
                self.state_dir.display(),
                self.repo_dir.display()
            ));
        }
        let remote = origin_forge(&self.repo_dir, &self.environment).ok_or_else(|| {
            "the checkout's origin does not name a supported repository".to_string()
        })?;
        if remote.forge == "gitlab" {
            return Err(format!(
                "the design agent supports a GitHub or Gitea origin, not a GitLab one: {}",
                remote.host
            ));
        }
        self.require_path("git")?;
        if remote.forge == "github" {
            self.require_path("gh")?;
        }
        self.forge_write_access(&remote, budget).await?;
        self.ensure_label(
            &remote,
            "design",
            "1f6feb",
            "Design system divergence from the documented interface",
            budget,
        )
        .await?;
        Ok(remote.project)
    }

    async fn preflight_dead_code(&self, budget: PreflightBudget) -> Result<String, String> {
        if let Some(problem) = root_problem(&self.repo_dir) {
            return Err(problem);
        }
        if !inside(&self.repo_dir, &self.state_dir) {
            return Err(format!(
                "STATE_DIR {} is not inside REPO_DIR {}; the dead-code worker keeps its state beside the checkout",
                self.state_dir.display(),
                self.repo_dir.display()
            ));
        }
        let remote = origin_forge(&self.repo_dir, &self.environment).ok_or_else(|| {
            "the checkout's origin does not name a supported repository".to_string()
        })?;
        if remote.forge == "gitlab" {
            return Err(format!(
                "the dead-code agent supports a GitHub or Gitea origin, not a GitLab one: {}",
                remote.host
            ));
        }
        self.require_installed_command("dead-code-removal")?;
        self.forge_write_access(&remote, budget).await?;
        self.ensure_label(
            &remote,
            "dead-code",
            "8250df",
            "Dead code proved removable by the Dead Code agent",
            budget,
        )
        .await?;
        Ok(remote.project)
    }

    async fn preflight_api_standards(&self, budget: PreflightBudget) -> Result<String, String> {
        let source_dir = crate::workers::api_standards::DEFAULT_API_SOURCE_DIRECTORY;
        let skill_dir = ".omp/skills/devboard-restful-api-implementation";
        let skill_document = format!("{skill_dir}/SKILL.md");
        let rules_document = format!("{skill_dir}/references/zalando-rest-rules.md");
        let source_root = self.repo_dir.join(source_dir);
        if !source_root.exists() {
            return Err(format!(
                "missing prerequisite: the canonical harness source checkout has no {source_dir} directory (an installed npm prefix is refused)"
            ));
        }
        match std::fs::symlink_metadata(&source_root) {
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => {
                return Err(format!(
                    "missing prerequisite: {source_dir} is not a directory"
                ))
            }
            Err(_) => {
                return Err(format!(
                    "missing prerequisite: {source_dir} is not readable"
                ))
            }
        }
        read_rest_skill(&self.repo_dir, &skill_document, &rules_document)?;
        if !inside(&self.repo_dir, &self.state_dir) {
            return Err(format!(
                "STATE_DIR {} is not inside REPO_DIR {}; the api-standards worker keeps its state beside the checkout",
                self.state_dir.display(),
                self.repo_dir.display()
            ));
        }
        let remote = origin_forge(&self.repo_dir, &self.environment).ok_or_else(|| {
            "the checkout's origin does not name a supported repository".to_string()
        })?;
        if remote.forge == "gitlab" {
            return Err(format!(
                "the API Standards agent supports a GitHub or Gitea origin, not a GitLab one: {}",
                remote.host
            ));
        }
        self.forge_write_access(&remote, budget).await?;
        self.ensure_label(
            &remote,
            "api-standards",
            "0e8a16",
            "HTTP API deviation from the project REST standard",
            budget,
        )
        .await?;
        Ok(remote.project)
    }

    async fn preflight_single_responsibility(
        &self,
        budget: PreflightBudget,
    ) -> Result<String, String> {
        if let Some(problem) = root_problem(&self.repo_dir) {
            return Err(problem);
        }
        let skill_document = ".omp/skills/devboard-single-responsibility-principle/SKILL.md";
        let skill_path = self.repo_dir.join(skill_document);
        let metadata = match std::fs::symlink_metadata(&skill_path) {
            Ok(metadata) => metadata,
            Err(_) => {
                return Err(format!(
                    "missing prerequisite: the skill {skill_document} is not readable"
                ))
            }
        };
        let skill_real = match std::fs::canonicalize(&skill_path) {
            Ok(path) => path,
            Err(_) => {
                return Err(format!(
                    "missing prerequisite: the skill {skill_document} is not readable"
                ))
            }
        };
        let repo_real =
            std::fs::canonicalize(&self.repo_dir).unwrap_or_else(|_| self.repo_dir.clone());
        if !skill_real.starts_with(&repo_real) {
            return Err(format!(
                "missing prerequisite: the skill {skill_document} resolves outside the repository"
            ));
        }
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(format!(
                "missing prerequisite: the skill {skill_document} is not a regular file"
            ));
        }
        read_skill_directives(&self.repo_dir, skill_document)?;
        if !inside_or_equal(&self.repo_dir, &self.state_dir) {
            return Err(format!(
                "STATE_DIR {} is not inside REPO_DIR {}; the single-responsibility worker keeps its state beside the checkout",
                self.state_dir.display(),
                self.repo_dir.display()
            ));
        }
        let remote = origin_forge(&self.repo_dir, &self.environment).ok_or_else(|| {
            "the checkout's origin does not name a supported repository".to_string()
        })?;
        if remote.forge == "gitlab" {
            return Err(format!(
                "the Single Responsibility agent supports a GitHub or Gitea origin, not a GitLab one: {}",
                remote.host
            ));
        }
        self.require_installed_command("single-responsibility")?;
        self.forge_write_access(&remote, budget).await?;
        self.ensure_label(
            &remote,
            "single-responsibility",
            "0e8a16",
            "Single Responsibility violation proved against the project SRP skill",
            budget,
        )
        .await?;
        Ok(remote.project)
    }

    async fn preflight_consistent_naming(&self, budget: PreflightBudget) -> Result<String, String> {
        if let Some(problem) = root_problem(&self.repo_dir) {
            return Err(problem);
        }
        let skill_document = ".omp/skills/devboard-consistent-naming/SKILL.md";
        let skill_path = self.repo_dir.join(skill_document);
        let metadata = match std::fs::symlink_metadata(&skill_path) {
            Ok(metadata) => metadata,
            Err(_) => {
                return Err(format!(
                    "missing prerequisite: the skill {skill_document} is not readable"
                ))
            }
        };
        let skill_real = match std::fs::canonicalize(&skill_path) {
            Ok(path) => path,
            Err(_) => {
                return Err(format!(
                    "missing prerequisite: the skill {skill_document} is not readable"
                ))
            }
        };
        let repo_real =
            std::fs::canonicalize(&self.repo_dir).unwrap_or_else(|_| self.repo_dir.clone());
        if !skill_real.starts_with(&repo_real) {
            return Err(format!(
                "missing prerequisite: the skill {skill_document} resolves outside the repository"
            ));
        }
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(format!(
                "missing prerequisite: the skill {skill_document} is not a regular file"
            ));
        }
        crate::workers::consistent_naming::read_skill_directives(&self.repo_dir, skill_document)
            .map_err(|detail| format!("missing prerequisite: the skill is unusable: {detail}"))?;
        if !inside_or_equal(&self.repo_dir, &self.state_dir) {
            return Err(format!(
                "STATE_DIR {} is not inside REPO_DIR {}; the consistent-naming worker keeps its state beside the checkout",
                self.state_dir.display(),
                self.repo_dir.display()
            ));
        }
        let remote = origin_forge(&self.repo_dir, &self.environment).ok_or_else(|| {
            "the checkout's origin does not name a supported repository".to_string()
        })?;
        if remote.forge == "gitlab" {
            return Err(format!(
                "the Consistent Naming agent supports a GitHub or Gitea origin, not a GitLab one: {}",
                remote.host
            ));
        }
        self.require_installed_command("consistent-naming")?;
        self.forge_write_access(&remote, budget).await?;
        self.ensure_label(
            &remote,
            "consistent-naming",
            "1d76db",
            "Consistent Naming vocabulary change proved against the project naming skill",
            budget,
        )
        .await?;
        Ok(remote.project)
    }
}

fn empty_repo_input(descriptor: &Descriptor) -> SnapshotInput {
    SnapshotInput {
        lifecycle: "stopped".to_string(),
        paused: false,
        enabled: false,
        owned: false,
        attached: false,
        minutes: descriptor.default_minutes,
        last_run_at: None,
        next_run_at: None,
        limits: Limits {
            max_per_hour: descriptor.max_per_hour,
            max_pending: descriptor.max_pending,
        },
        issues: Vec::new(),
        documentation: Vec::new(),
        releases: Vec::new(),
        pending: 0,
        sync: AgentSync::stale(),
        detail: if descriptor.panel == "activity" {
            Detail::Activity {
                scan_id: None,
                entries: Vec::new(),
            }
        } else {
            Detail::Cycles(Vec::new())
        },
        notice: None,
        error: None,
        timer: None,
        workers: Vec::new(),
    }
}

fn merge_documentation(states: &[RepoState]) -> Vec<Value> {
    let mut seen = HashSet::new();
    let mut entries: Vec<Value> = Vec::new();
    for state in states {
        for entry in &state.documentation {
            let version = entry.get("version").and_then(Value::as_str).unwrap_or("");
            let at = entry.get("at").and_then(Value::as_str).unwrap_or("");
            let key = format!("{version}\u{0}{at}");
            if seen.insert(key) {
                entries.push(entry.clone());
            }
        }
    }
    entries.sort_by(|left, right| {
        let left = left.get("at").and_then(Value::as_str).unwrap_or("");
        let right = right.get("at").and_then(Value::as_str).unwrap_or("");
        right.cmp(left)
    });
    entries.truncate(DOCUMENTATION_HISTORY_LIMIT);
    entries
}

fn still_stopping(mutable: &Mutex<RepoMutable>, pid: u32) -> bool {
    mutable
        .lock()
        .map(|mutable| mutable.stopping.contains(&pid))
        .unwrap_or(false)
}

fn clear_stopping(mutable: &Mutex<RepoMutable>, pid: u32) {
    if let Ok(mut mutable) = mutable.lock() {
        mutable.stopping.remove(&pid);
    }
}

fn design_is_releasing(paths: &[PathBuf], pid: u32) -> bool {
    let states: Vec<RepoState> = paths
        .iter()
        .filter_map(|path| std::fs::read_to_string(path).ok())
        .filter_map(|text| parse_repo_state(RepoFamilyId::Design, &text))
        .collect();
    let releasing = states
        .iter()
        .find(|state| state.worker.as_ref().map(|worker| worker.pid) == Some(pid))
        .or_else(|| states.iter().find(|state| state.worker.is_none()))
        .map(|state| state.lifecycle == "releasing")
        .unwrap_or(false);
    releasing
}

fn strict_limit(value: &Option<Value>) -> Option<Option<u32>> {
    match value {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::Number(number)) => number
            .as_u64()
            .filter(|value| (1..=100).contains(value))
            .map(|value| Some(value as u32)),
        _ => None,
    }
}

fn write_settings_atomically(path: &Path, value: &Value) -> Result<(), std::io::Error> {
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(value).unwrap_or_default()
    );
    crate::state::write_file_atomically_sync(path, &text)
}

fn state_inside_repository(repo_dir: &Path, state_dir: &Path) -> bool {
    let root = resolved(repo_dir);
    let state = resolved(state_dir);
    match state.strip_prefix(&root) {
        Ok(relative) => !relative.as_os_str().is_empty(),
        Err(_) => false,
    }
}

fn inside_or_equal(root: &Path, candidate: &Path) -> bool {
    let root = resolved(root);
    let candidate = resolved(candidate);
    candidate.starts_with(&root)
}

fn proves_worker(pid: u32, family_id: RepoFamilyId, repo_dir: &Path, canonical: &Path) -> bool {
    let argv = match crate::supervision::process_argv(pid) {
        Some(argv) => argv,
        None => return false,
    };
    let family = family_id.directory();
    let mounted = argv
        .windows(2)
        .any(|pair| pair[0] == "worker" && pair[1] == family)
        || argv.iter().any(|entry| {
            entry.ends_with(&format!("{family}/worker.ts"))
                || entry.ends_with(&format!("issues/{family}/worker.ts"))
        });
    if !mounted {
        return false;
    }
    if !argv.iter().any(|entry| Path::new(entry) == repo_dir) {
        return false;
    }
    match std::fs::read_link(format!("/proc/{pid}/cwd")) {
        Ok(cwd) => cwd == canonical,
        Err(_) => false,
    }
}

fn gh_command(
    environment: &HashMap<String, String>,
    argv: &[&str],
    timeout_ms: Option<u64>,
) -> Pin<Box<dyn Future<Output = Result<GhOutcome, String>> + Send>> {
    let environment = environment.clone();
    let argv: Vec<String> = argv.iter().map(|value| (*value).to_string()).collect();
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
            Err(error) => return Err(error.to_string()),
        };
        let wait = child.wait_with_output();
        let output = match timeout_ms {
            Some(ms) => match tokio::time::timeout(Duration::from_millis(ms.max(1)), wait).await {
                Ok(result) => result.map_err(|error| error.to_string())?,
                Err(_) => return Err("the command did not finish before its deadline".to_string()),
            },
            None => wait.await.map_err(|error| error.to_string())?,
        };
        Ok(GhOutcome {
            code: output.status.code().unwrap_or(1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    })
}

struct GhOutcome {
    code: i32,
    stdout: String,
    stderr: String,
}

/// One Gitea target for a preflight, built from the checkout's origin and the
/// configured credential.
fn gitea_preflight_target(
    remote: &ForgeRemote,
    environment: &HashMap<String, String>,
) -> Result<(crate::forge::GiteaTarget, String), String> {
    let base_url = gitea_base_url(remote, environment).ok_or_else(|| {
        "missing prerequisite: the Gitea address is not configured (set DEVBOARD_GITEA_URL or use an HTTP(S) origin)".to_string()
    })?;
    let token = configured_gitea_token(environment)
        .ok_or_else(|| "missing prerequisite: GITEA_TOKEN is not set".to_string())?;
    let target = crate::forge::gitea_target(
        None,
        Some(&remote.project),
        Some(&base_url),
        Some(&token),
        environment,
    )
    .map_err(|error| format!("missing prerequisite: {}", error.message))?;
    Ok((target, base_url))
}

/// Why one preflight could not read the forge fact `subject` names — the
/// repository, or its labels. A permanent refusal names the missing fact; a
/// stall, a refused credential, or a 5xx answer is a transient fault the next
/// Start retries, so it is never reported as a missing prerequisite.
fn gitea_read_failure(
    subject: &str,
    kind: crate::forge::ForgeReadFailureKind,
    reason: &str,
) -> String {
    match kind {
        crate::forge::ForgeReadFailureKind::Permanent => {
            format!("missing prerequisite: {subject} could not be read: {reason}")
        }
        _ => format!(
            "{subject} could not be read before Start's deadline: {reason}; press Start to retry."
        ),
    }
}

/// The `start_error` and `notice` fields one Start preflight refusal publishes.
///
/// A refusal that names a step which ran out of time is latency: the request
/// was still in flight against a forge that is slow, not broken, and the next
/// Start runs the same preflight again. Publishing it as the family's error
/// raises an error notification, and the page files a board issue for that
/// notification — more load for the forge already behind. It stays on the card
/// as the family's notice instead, so the operator still reads why Start
/// spawned nothing. Every other refusal names a fault the operator must fix
/// and keeps `start_error`.
fn start_refusal_fields(message: String) -> (Option<String>, Option<String>) {
    if crate::forge::is_forge_read_latency(&message) {
        (None, Some(message))
    } else {
        (Some(message), None)
    }
}

/// Reads the repository document through the shared Gitea client. A fast
/// transient refusal spends the shared retry schedule while the budget lasts,
/// and a stalled request reports the request it was making instead of the
/// step's generic deadline.
async fn gitea_repository_within(
    budget: PreflightBudget,
    target: &crate::forge::GiteaTarget,
    transport: &crate::forge::Transport,
) -> Result<Value, String> {
    let subject = format!("the Gitea repository {}", target.project);
    let mut retry = crate::forge::ForgeReadRetry::new();
    loop {
        let call = crate::forge::GiteaCallOptions {
            flow_id: None,
            timeout_ms: Some(budget.request_ms()),
        };
        let attempt = budget
            .run("reading the Gitea repository", async {
                crate::forge::gitea_repository(target, transport, &call)
                    .await
                    .map(|repository| repository.document)
                    .map_err(|error| error.message)
            })
            .await;
        let reason = match attempt {
            Ok(document) => return Ok(document),
            Err(reason) => reason,
        };
        let kind = crate::forge::classify_forge_read_failure(&reason);
        let Some(delay) = retry.record(kind) else {
            return Err(gitea_read_failure(&subject, kind, &reason));
        };
        if budget.remaining_ms() <= delay + PREFLIGHT_RETRY_WINDOW_MS {
            return Err(gitea_read_failure(&subject, kind, &reason));
        }
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
}

/// Reads the repository's labels through the shared Gitea client under the
/// same policy as [`gitea_repository_within`]: a fast transient refusal spends
/// the shared retry schedule while the preflight's deadline lasts, and a
/// stalled request reports the request it was making instead of the step's
/// generic deadline. The label step has no separate policy: a slow forge must
/// not turn a label read into a raw transport error on the Start card.
async fn gitea_labels_within(
    budget: PreflightBudget,
    target: &crate::forge::GiteaTarget,
    transport: &crate::forge::Transport,
) -> Result<Vec<crate::forge::GiteaLabel>, String> {
    let subject = format!("the labels of {}", target.project);
    let mut retry = crate::forge::ForgeReadRetry::new();
    loop {
        let call = crate::forge::GiteaCallOptions {
            flow_id: None,
            timeout_ms: Some(budget.request_ms()),
        };
        let attempt = budget
            .run("reading the Gitea labels", async {
                crate::forge::gitea_labels(target, transport, &call)
                    .await
                    .map_err(|error| error.message)
            })
            .await;
        let reason = match attempt {
            Ok(labels) => return Ok(labels),
            Err(reason) => reason,
        };
        let kind = crate::forge::classify_forge_read_failure(&reason);
        let Some(delay) = retry.record(kind) else {
            return Err(gitea_read_failure(&subject, kind, &reason));
        };
        if budget.remaining_ms() <= delay + PREFLIGHT_RETRY_WINDOW_MS {
            return Err(gitea_read_failure(&subject, kind, &reason));
        }
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
}

fn read_rest_skill(
    repo_dir: &Path,
    skill_document: &str,
    rules_document: &str,
) -> Result<(), String> {
    let read = |relative: &str| -> Result<String, String> {
        std::fs::read_to_string(repo_dir.join(relative))
            .map_err(|_| format!("{relative} is not readable"))
    };
    let skill_text = read(skill_document)?;
    if skill_text.trim().is_empty() {
        return Err(format!("{skill_document} is empty"));
    }
    let rules_text = read(rules_document)?;
    let mut chapter: Option<String> = None;
    let mut rows = 0usize;
    let mut seen = HashSet::new();
    for line in rules_text.split('\n') {
        let line = line.trim_end_matches('\r');
        if let Some(heading) = line.strip_prefix("## ") {
            let heading = heading.trim();
            chapter = if heading.is_empty() {
                None
            } else {
                Some(heading.to_string())
            };
            continue;
        }
        if chapter.is_none() {
            continue;
        }
        let trimmed = line.trim();
        if !trimmed.starts_with('|') || !trimmed.ends_with('|') {
            continue;
        }
        let cells: Vec<String> = trimmed[1..trimmed.len() - 1]
            .split('|')
            .map(|cell| cell.trim().to_string())
            .collect();
        if cells.len() != 3 {
            continue;
        }
        let id = &cells[0];
        if !id.chars().all(|character| character.is_ascii_digit()) || id.is_empty() {
            continue;
        }
        if !matches!(cells[1].as_str(), "MUST" | "SHOULD" | "MAY") {
            continue;
        }
        if cells[2].is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        rows += 1;
    }
    if rows == 0 {
        return Err(format!(
            "{rules_document} has no rule table; the skill must list | <rule id> | <MUST|SHOULD|MAY> | <directive> | rows under its chapter headings"
        ));
    }
    Ok(())
}

fn read_skill_directives(repo_dir: &Path, skill_document: &str) -> Result<(), String> {
    let text = std::fs::read_to_string(repo_dir.join(skill_document))
        .map_err(|_| format!("{skill_document} is not readable"))?;
    if text.trim().is_empty() {
        return Err(format!("{skill_document} is empty"));
    }
    let categories = [
        ("mixed responsibilities", "mixed-responsibilities"),
        ("divergent change", "divergent-change"),
        ("accidental aggregation", "accidental-aggregation"),
        ("responsibility leakage", "responsibility-leakage"),
        ("artificial fragmentation", "artificial-fragmentation"),
    ];
    let mut found = HashSet::new();
    let mut in_violations = false;
    for line in text.split('\n') {
        let line = line.trim_end_matches('\r');
        if let Some(heading) = line.strip_prefix("## ") {
            in_violations = heading.trim().to_lowercase() == "architectural violations";
            continue;
        }
        if !in_violations {
            continue;
        }
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix("- ") else {
            continue;
        };
        let Some(rest) = rest.strip_prefix("**") else {
            continue;
        };
        let Some((label, _)) = rest.split_once(":**") else {
            continue;
        };
        let label = label.trim().to_lowercase();
        if let Some((_, category)) = categories.iter().find(|(title, _)| *title == label) {
            found.insert((*category).to_string());
        }
    }
    for (_, category) in categories {
        if !found.contains(category) {
            return Err(format!(
                "{skill_document} publishes no Architectural Violations bullet for {category}"
            ));
        }
    }
    Ok(())
}

/* ------------------------------------------------------------------------ */
/* Watchdog                                                                  */
/* ------------------------------------------------------------------------ */

#[derive(Clone, Debug)]
struct WatchdogWorkerState {
    pid: u32,
    started_at: String,
    /// Required by the reference's state shape; validated, never read.
    #[allow(dead_code)]
    root: String,
    state_dir: String,
    lifecycle: String,
    enabled: bool,
    harness_version: Option<String>,
    /// Required by the reference's state shape; validated, never read.
    #[allow(dead_code)]
    argv: Vec<String>,
    last_run_at: Option<String>,
    next_run_at: Option<String>,
    last_error: Option<String>,
    notice: Option<String>,
    updated_at: String,
}

fn parse_watchdog_worker_state(text: &str) -> Option<WatchdogWorkerState> {
    let value: Value = serde_json::from_str(text).ok()?;
    let object = value.as_object()?;
    if object.get("version")?.as_u64()? != 1 {
        return None;
    }
    let pid = object.get("pid")?.as_u64()? as u32;
    if pid == 0 {
        return None;
    }
    let lifecycle = object.get("lifecycle")?.as_str()?;
    if !LIFECYCLES.contains(&lifecycle) {
        return None;
    }
    Some(WatchdogWorkerState {
        pid,
        started_at: object.get("startedAt")?.as_str()?.to_string(),
        root: object.get("root")?.as_str()?.to_string(),
        state_dir: object.get("stateDir")?.as_str()?.to_string(),
        lifecycle: lifecycle.to_string(),
        enabled: object.get("enabled")?.as_bool()?,
        harness_version: object
            .get("harnessVersion")
            .and_then(Value::as_str)
            .map(str::to_string),
        argv: object
            .get("argv")?
            .as_array()?
            .iter()
            .map(|entry| entry.as_str().map(str::to_string))
            .collect::<Option<Vec<String>>>()?,
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
        updated_at: object.get("updatedAt")?.as_str()?.to_string(),
    })
}

fn read_watchdog_worker_state(directory: &Path) -> Option<WatchdogWorkerState> {
    parse_watchdog_worker_state(&std::fs::read_to_string(directory.join("worker.json")).ok()?)
}

fn read_watchdog_worker_states(directory: &Path) -> Vec<WatchdogWorkerState> {
    let mut states = Vec::new();
    if let Some(state) = read_watchdog_worker_state(directory) {
        states.push(state);
    }
    for version_directory in worker_state_directories(directory) {
        if let Some(state) = read_watchdog_worker_state(&version_directory) {
            states.push(state);
        }
    }
    states
}

fn watchdog_directory(repo_dir: &Path) -> PathBuf {
    repo_dir.join(".devboard").join(".tmp").join("watchdog")
}

fn watchdog_settings_path(directory: &Path) -> PathBuf {
    directory.join("settings.json")
}

fn read_watchdog_settings(directory: &Path) -> BasicSettings {
    read_basic_settings(&watchdog_settings_path(directory)).unwrap_or(BasicSettings {
        interval_minutes: 10,
        max_per_hour: None,
        max_pending: None,
    })
}

fn watchdog_issue_rows(directory: &Path) -> Vec<Value> {
    let ledger = read_json(&directory.join("state.json")).unwrap_or(Value::Null);
    let Some(findings) = ledger.get("findings").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut rows: Vec<Value> = findings
        .values()
        .filter_map(|entry| {
            let disposition = entry.get("disposition").and_then(Value::as_str)?;
            let url = entry.get("url").and_then(Value::as_str)?;
            if !disposition.starts_with("filed:") {
                return None;
            }
            Some(json!({
                "url": url,
                "category": entry.get("category").and_then(Value::as_str).unwrap_or(""),
                "line": entry.get("line").and_then(Value::as_str).unwrap_or(""),
                "filedAt": entry
                    .get("filedAt")
                    .and_then(Value::as_str)
                    .or_else(|| entry.get("firstSeen").and_then(Value::as_str))
                    .unwrap_or(""),
            }))
        })
        .collect();
    rows.sort_by(|left, right| {
        let left_at = left.get("filedAt").and_then(Value::as_str).unwrap_or("");
        let right_at = right.get("filedAt").and_then(Value::as_str).unwrap_or("");
        right_at.cmp(left_at).then_with(|| {
            left.get("url")
                .and_then(Value::as_str)
                .unwrap_or("")
                .cmp(right.get("url").and_then(Value::as_str).unwrap_or(""))
        })
    });
    rows
}

fn watchdog_pending(directory: &Path) -> u64 {
    read_json(&directory.join("state.json"))
        .and_then(|ledger| {
            ledger
                .get("pendingFiling")
                .and_then(Value::as_array)
                .map(Vec::len)
        })
        .unwrap_or(0) as u64
}

fn ledger_url_for(directory: &Path, fingerprint: &str) -> Option<String> {
    read_json(&directory.join("state.json")).and_then(|ledger| {
        ledger
            .get("findings")
            .and_then(Value::as_object)
            .and_then(|findings| findings.get(fingerprint))
            .and_then(|entry| entry.get("url"))
            .and_then(Value::as_str)
            .map(str::to_string)
    })
}

fn cycle_from_report(report: &Value, resolve: &dyn Fn(&str) -> Option<String>) -> Option<Value> {
    let object = report.as_object()?;
    let at = object.get("cycle")?.as_str()?;
    if at.is_empty() {
        return None;
    }
    let window = object.get("window").and_then(Value::as_object);
    let start = window
        .and_then(|window| window.get("start"))
        .and_then(Value::as_str)
        .map(|text| Value::String(text.to_string()))
        .unwrap_or(Value::Null);
    let end = window
        .and_then(|window| window.get("end"))
        .and_then(Value::as_str)
        .map(|text| Value::String(text.to_string()))
        .unwrap_or(Value::Null);
    let mut urls: Vec<String> = Vec::new();
    if let Some(findings) = object.get("findings").and_then(Value::as_array) {
        for finding in findings {
            if let Some(fingerprint) = finding.get("fingerprint").and_then(Value::as_str) {
                if let Some(url) = resolve(fingerprint) {
                    if !url.is_empty() && !urls.contains(&url) {
                        urls.push(url);
                    }
                }
            }
        }
    }
    if let Some(issues) = object.get("issues").and_then(Value::as_array) {
        for issue in issues {
            if let Some(url) = issue.get("url").and_then(Value::as_str) {
                if !url.is_empty() && !urls.contains(&url.to_string()) {
                    urls.push(url.to_string());
                }
            }
        }
    }
    let mut row = Map::new();
    row.insert("at".to_string(), Value::String(at.to_string()));
    row.insert("window".to_string(), json!({"start": start, "end": end}));
    row.insert(
        "action".to_string(),
        Value::String(
            object
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("none")
                .to_string(),
        ),
    );
    row.insert(
        "findings".to_string(),
        json!(object
            .get("findings")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0)),
    );
    row.insert(
        "issues".to_string(),
        Value::Array(urls.into_iter().map(Value::String).collect()),
    );
    if let Some(reason) = object.get("reason").and_then(Value::as_str) {
        row.insert("reason".to_string(), Value::String(reason.to_string()));
    }
    Some(Value::Object(row))
}

fn read_cycles(
    directory: &Path,
    latest: Option<Value>,
    resolve: &dyn Fn(&str) -> Option<String>,
) -> Vec<Value> {
    let mut names: Vec<String> = std::fs::read_dir(directory.join("runs"))
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|entry| entry.path().is_dir())
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort_by(|left, right| right.cmp(left));
    names.truncate(100);
    if names.is_empty() {
        return latest.into_iter().collect();
    }
    let mut cycles = Vec::new();
    for name in names {
        // A run records a bounded summary beside its report, which carries the
        // whole cycle evidence; a projection is a Start's answer frame, so it
        // reads the summary and never re-parses that evidence.
        if let Some(report) = crate::workers::cycle::read_run(&directory.join("runs").join(&name)) {
            if let Some(cycle) = cycle_from_report(&report, resolve) {
                cycles.push(cycle);
            }
        }
    }
    cycles
}

/// The document describing a family's latest cycle. The newest run's summary
/// is the same cycle `latest.json` copies, read without parsing the report that
/// carries the whole cycle evidence; `latest.json` answers only when the family
/// kept no run for it.
fn latest_cycle_document(directory: &Path) -> Value {
    crate::workers::cycle::latest_run(directory)
        .or_else(|| read_json(&directory.join("latest.json")))
        .unwrap_or(Value::Null)
}

fn watchdog_status(
    directory: &Path,
) -> (
    Option<String>,
    String,
    u64,
    Vec<Value>,
    u64,
    Vec<Value>,
    Vec<Value>,
) {
    let latest = latest_cycle_document(directory);
    let latest_object = latest.as_object();
    let cycle = latest_object
        .and_then(|object| object.get("cycle"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let action = latest_object
        .and_then(|object| object.get("action"))
        .and_then(Value::as_str)
        .unwrap_or("none")
        .to_string();
    let findings = latest_object
        .and_then(|object| object.get("findings"))
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0) as u64;
    let issues = watchdog_issue_rows(directory);
    let pending = watchdog_pending(directory);
    let resolve = |fingerprint: &str| ledger_url_for(directory, fingerprint);
    let latest_cycle = cycle_from_report(&latest, &resolve);
    let cycles = read_cycles(directory, latest_cycle, &resolve);
    let mut status_rows = Vec::new();
    for issue in &issues {
        let url = issue.get("url").and_then(Value::as_str).unwrap_or("");
        status_rows.push(json!({
            "title": format!(
                "[watchdog] {}: {}",
                issue.get("category").and_then(Value::as_str).unwrap_or(""),
                issue.get("line").and_then(Value::as_str).unwrap_or("")
            ),
            "category": issue.get("category").cloned().unwrap_or(Value::Null),
            "filedAt": issue.get("filedAt").cloned().unwrap_or(Value::Null),
            "url": url,
        }));
    }
    (
        cycle,
        action,
        findings,
        status_rows,
        pending,
        cycles,
        issues,
    )
}

struct WatchdogMutable {
    preview_starting: bool,
    timer_gate: Option<TimerGate>,
    timer_read_at: i64,
    timer_reading: bool,
    starting: bool,
    starting_since: Option<i64>,
    start_deadline: Option<i64>,
    start_pending: bool,
    start_cancelled: bool,
    stop_requested: bool,
    start_error: Option<String>,
    notice: Option<String>,
    stopping: HashSet<u32>,
    takeover: bool,
    legacy_control_keys: HashSet<String>,
}

struct WatchdogFamily {
    descriptor: &'static Descriptor,
    repo_dir: PathBuf,
    state_dir: PathBuf,
    directory: PathBuf,
    running_version: Option<String>,
    environment: HashMap<String, String>,
    spawn: SharedSpawn,
    preflight_override: SharedPreflight,
    preflight_timeout_ms: Arc<AtomicU64>,
    forge: ForgeProjection,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    mutable: Arc<Mutex<WatchdogMutable>>,
    start_lock: tokio::sync::Mutex<()>,
}

impl WatchdogFamily {
    fn new(
        repo_dir: &Path,
        state_dir: &Path,
        environment: &HashMap<String, String>,
        running_version: Option<String>,
        spawn: SharedSpawn,
        preflight_override: SharedPreflight,
        forge_reader: Option<ForgeReader>,
        now: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Self {
        Self {
            descriptor: descriptor("watchdog").expect("watchdog descriptor"),
            repo_dir: repo_dir.to_path_buf(),
            state_dir: state_dir.to_path_buf(),
            directory: watchdog_directory(repo_dir),
            running_version,
            environment: environment.clone(),
            spawn,
            preflight_override,
            preflight_timeout_ms: Arc::new(AtomicU64::new(AGENT_PREFLIGHT_TIMEOUT_MS)),
            forge: ForgeProjection::new(forge_reader, Vec::new()),
            now,
            mutable: Arc::new(Mutex::new(WatchdogMutable {
                preview_starting: false,
                timer_gate: None,
                timer_read_at: 0,
                timer_reading: false,
                starting: false,
                starting_since: None,
                start_deadline: None,
                start_pending: false,
                start_cancelled: false,
                stop_requested: false,
                start_error: None,
                notice: None,
                stopping: HashSet::new(),
                takeover: false,
                legacy_control_keys: HashSet::new(),
            })),
            start_lock: tokio::sync::Mutex::new(()),
        }
    }

    fn lock_path(&self) -> PathBuf {
        self.directory.join("lock")
    }

    fn preflight_timeout_cell(&self) -> Arc<AtomicU64> {
        Arc::clone(&self.preflight_timeout_ms)
    }

    fn versioned_worker_directory(&self, version: Option<&str>) -> PathBuf {
        self.directory
            .join("workers")
            .join(worker_version_key(version))
    }

    fn control_for(&self, owner: &LockOwner) -> PathBuf {
        if let Some(version) = owner.harness_version.as_deref() {
            let key = format!("{}:{}", owner.pid, version);
            let legacy = self
                .mutable
                .lock()
                .map(|mutable| mutable.legacy_control_keys.contains(&key))
                .unwrap_or(false);
            if !legacy {
                return self
                    .versioned_worker_directory(Some(version))
                    .join("control");
            }
        }
        self.directory.join("control")
    }

    fn state_for_owner(&self, owner: &LockOwner) -> Option<WatchdogWorkerState> {
        if let Some(version) = owner.harness_version.as_deref() {
            if let Some(state) =
                read_watchdog_worker_state(&self.versioned_worker_directory(Some(version)))
            {
                if state.pid == owner.pid {
                    return Some(state);
                }
            }
        }
        let legacy = read_watchdog_worker_state(&self.directory)?;
        if legacy.pid == owner.pid {
            Some(legacy)
        } else {
            None
        }
    }

    fn owners(&self) -> Vec<LockOwner> {
        let mut owners = live_lock_owners(&self.lock_path());
        let legacy = read_watchdog_worker_state(&self.directory);
        if let Some(legacy) = legacy {
            if legacy.lifecycle != "stopped" && pid_alive(legacy.pid) {
                let key = format!(
                    "{}:{}",
                    legacy.pid,
                    legacy.harness_version.as_deref().unwrap_or("unknown")
                );
                if let Ok(mut mutable) = self.mutable.lock() {
                    mutable.legacy_control_keys.insert(key);
                }
                if !owners.iter().any(|owner| {
                    owner.pid == legacy.pid && owner.harness_version == legacy.harness_version
                }) {
                    owners.push(LockOwner {
                        pid: legacy.pid,
                        started_at: legacy.started_at,
                        state_dir: legacy.state_dir,
                        harness_version: legacy.harness_version,
                    });
                }
            }
        }
        owners
    }

    fn forge_urls(&self) -> Vec<String> {
        watchdog_issue_rows(&self.directory)
            .into_iter()
            .filter_map(|issue| issue.get("url").and_then(Value::as_str).map(str::to_string))
            .collect()
    }

    fn poll_signature(&self) -> u64 {
        use std::hash::{Hash, Hasher};

        let mut timer = std::collections::hash_map::DefaultHasher::new();
        if let Ok(mutable) = self.mutable.lock() {
            if let Some(gate) = &mutable.timer_gate {
                gate.unit.hash(&mut timer);
                gate.state.hash(&mut timer);
                gate.blocked.hash(&mut timer);
                gate.error.hash(&mut timer);
            }
            mutable.timer_reading.hash(&mut timer);
        }
        tree_signature(&self.directory) ^ timer.finish()
    }

    fn rebuild_always(&self) -> bool {
        let Ok(mutable) = self.mutable.lock() else {
            return true;
        };
        mutable.starting
            || mutable.preview_starting
            || mutable.start_pending
            || mutable.stop_requested
            || !mutable.stopping.is_empty()
            || mutable.timer_reading
    }

    fn snapshot(&self) -> Value {
        let now = (self.now)();
        if self.forge_urls().is_empty() {
            self.forge.note_empty_read(now);
        }
        let owners = self.owners();
        let own: Vec<LockOwner> = owners
            .iter()
            .filter(|owner| resolved(Path::new(&owner.state_dir)) == resolved(&self.state_dir))
            .cloned()
            .collect();
        let foreign = owners
            .iter()
            .find(|owner| resolved(Path::new(&owner.state_dir)) != resolved(&self.state_dir))
            .cloned();
        let attached = !owners.is_empty();
        let owned = !own.is_empty();
        let states = read_watchdog_worker_states(&self.directory);
        let own_states: Vec<WatchdogWorkerState> = own
            .iter()
            .filter_map(|owner| self.state_for_owner(owner))
            .collect();
        let mut newest_states = states.clone();
        newest_states.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        let newest = newest_states.first().cloned();
        {
            let Ok(mut mutable) = self.mutable.lock() else {
                return project_snapshot(self.descriptor, empty_repo_input(self.descriptor));
            };
            if (mutable.starting || mutable.preview_starting) && attached {
                // A worker is attached, so the start this preview announced has
                // happened: the preview never outlives its own Start.
                mutable.starting = false;
                mutable.starting_since = None;
                mutable.start_deadline = None;
                mutable.preview_starting = false;
            }
            if attached {
                mutable.start_error = None;
            }
            if mutable.starting
                && mutable
                    .start_deadline
                    .is_some_and(|deadline| now > deadline)
            {
                mutable.starting = false;
                mutable.starting_since = None;
                mutable.start_deadline = None;
                mutable.preview_starting = false;
                mutable.start_pending = false;
                mutable.start_cancelled = false;
                mutable.start_error =
                    Some("the Watchdog start did not finish; press Start to retry.".to_string());
            }
            if mutable.starting {
                if let Some(since) = mutable.starting_since {
                    if now - since > START_PROOF_MS {
                        mutable.starting = false;
                        mutable.starting_since = None;
                        mutable.start_error = Some(
                            "the Watchdog worker did not publish its state within 5 seconds"
                                .to_string(),
                        );
                    }
                }
            }
            if mutable.stop_requested && !attached {
                mutable.stop_requested = false;
            }
            if !attached {
                mutable.stopping.clear();
            }
            if let Some(foreign) = foreign.as_ref() {
                if !mutable.notice.as_deref().is_some_and(is_start_refusal) {
                    mutable.notice = Some(format!(
                        "Watchdog is running for this root from another dashboard (STATE_DIR {}).",
                        foreign.state_dir
                    ));
                }
            } else if mutable
                .notice
                .as_ref()
                .map(|notice| {
                    notice.starts_with("Watchdog is running")
                        || notice.starts_with("Start did nothing: Watchdog is running")
                })
                .unwrap_or(false)
            {
                mutable.notice = None;
            }
            if owners.is_empty()
                && !mutable.starting
                && !mutable.start_pending
                && mutable
                    .notice
                    .as_deref()
                    .is_some_and(|notice| notice.starts_with("Start did nothing: the "))
            {
                mutable.notice = None;
            }
        }
        let mutable = self.mutable.lock().expect("watchdog state");
        let running_state = own_states.iter().find(|state| state.lifecycle == "running");
        let draining_state = own_states
            .iter()
            .find(|state| state.lifecycle == "stopping");
        let active = running_state
            .cloned()
            .or_else(|| draining_state.cloned())
            .or_else(|| newest.clone());
        let lifecycle = if mutable.starting || mutable.preview_starting {
            "starting".to_string()
        } else if mutable.stop_requested {
            "stopping".to_string()
        } else if running_state.is_some() {
            "running".to_string()
        } else if own_states.iter().any(|state| state.lifecycle == "stopping") {
            "stopping".to_string()
        } else if attached {
            if own_states.iter().any(|state| state.lifecycle == "failed") {
                "failed".to_string()
            } else {
                "running".to_string()
            }
        } else if newest
            .as_ref()
            .map(|state| state.lifecycle == "failed")
            .unwrap_or(false)
        {
            "failed".to_string()
        } else {
            "stopped".to_string()
        };
        let settings = read_watchdog_settings(&self.directory);
        let (status_cycle, _action, _findings, rows, pending, cycles, _issues) =
            watchdog_status(&self.directory);
        let mut last_run_candidates: Vec<String> = states
            .iter()
            .filter_map(|state| state.last_run_at.clone())
            .collect();
        last_run_candidates.sort();
        let last_run_at = last_run_candidates.last().cloned().or(status_cycle.clone());
        let workers: Vec<Worker> = own
            .iter()
            .map(|owner| {
                let state = self.state_for_owner(owner);
                Worker {
                    pid: owner.pid,
                    version: owner.harness_version.clone(),
                    state_dir: owner.state_dir.clone(),
                    lifecycle: state
                        .as_ref()
                        .map(|state| state.lifecycle.clone())
                        .unwrap_or_else(|| "running".to_string()),
                }
            })
            .collect();
        let issue_rows: Vec<Value> = rows
            .into_iter()
            .map(|row| {
                let url = row.get("url").and_then(Value::as_str).unwrap_or("");
                let fact = self.forge.fact(url);
                json!({
                    "title": row.get("title").cloned().unwrap_or(Value::Null),
                    "category": row.get("category").cloned().unwrap_or(Value::Null),
                    "filedAt": row.get("filedAt").cloned().unwrap_or(Value::Null),
                    "url": row.get("url").cloned().unwrap_or(Value::Null),
                    "state": fact.as_ref().map(|fact| fact.state.clone()).unwrap_or_else(|| "unknown".to_string()),
                    "version": fact.and_then(|fact| fact.version),
                })
            })
            .filter(|row| {
                self.forge
                    .reported(row.get("url").and_then(Value::as_str).unwrap_or(""))
            })
            .collect();
        project_snapshot(
            self.descriptor,
            SnapshotInput {
                lifecycle,
                paused: false,
                enabled: attached
                    && active.as_ref().map(|state| state.enabled).unwrap_or(false)
                    && !mutable.starting,
                owned,
                attached,
                minutes: settings.interval_minutes,
                last_run_at,
                next_run_at: if attached {
                    active.as_ref().and_then(|state| state.next_run_at.clone())
                } else {
                    None
                },
                limits: Limits {
                    max_per_hour: settings.max_per_hour,
                    max_pending: settings.max_pending,
                },
                issues: issue_rows,
                documentation: Vec::new(),
                releases: Vec::new(),
                pending,
                sync: self.forge.sync(now),
                detail: Detail::Cycles(cycles),
                notice: mutable
                    .notice
                    .clone()
                    .or_else(|| active.as_ref().and_then(|state| state.notice.clone())),
                error: mutable
                    .start_error
                    .clone()
                    .or_else(|| active.as_ref().and_then(|state| state.last_error.clone())),
                timer: mutable.timer_gate.clone(),
                workers,
            },
        )
    }

    /// The connect-time timer read. The replay must carry the gate the first
    /// snapshot shows, so this read is synchronous and bounded.
    fn refresh_timer_now(&self) {
        let Some(unit) = self.descriptor.timer_unit else {
            return;
        };
        if self
            .mutable
            .lock()
            .map(|mutable| mutable.timer_gate.is_some())
            .unwrap_or(false)
        {
            return;
        }
        static CACHE: std::sync::LazyLock<Mutex<HashMap<String, (TimerGate, i64)>>> =
            std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
        let now = now_millis();
        if let Ok(cache) = CACHE.lock() {
            if let Some((gate, read_at)) = cache.get(unit) {
                if now - *read_at < 60_000 {
                    if let Ok(mut mutable) = self.mutable.lock() {
                        mutable.timer_gate = Some(gate.clone());
                    }
                    return;
                }
            }
        }
        let run = |args: &[&str]| -> SystemctlOutcome {
            let mut command = std::process::Command::new("timeout");
            command
                .arg("2")
                .arg("systemctl")
                .arg("--user")
                .args(args)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            match command.output() {
                Ok(output) => SystemctlOutcome {
                    code: output.status.code().unwrap_or(1),
                    stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
                    stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
                },
                Err(_) => SystemctlOutcome {
                    code: 127,
                    stdout: String::new(),
                    stderr: "systemctl: not found".to_string(),
                },
            }
        };
        let available = run(&["is-active", unit]);
        let gate = if available.code == 127
            || available.stderr.contains("not found")
            || available.stderr.to_lowercase().contains("no such file")
        {
            TimerGate {
                unit: unit.to_string(),
                state: "absent".to_string(),
                blocked: false,
                error: None,
            }
        } else {
            let active = available.stdout.trim() == "active";
            let enabled_result = run(&["is-enabled", unit]);
            let enabled = enabled_result.stdout.trim() == "enabled";
            let known = matches!(available.stdout.trim(), "active" | "inactive")
                || matches!(enabled_result.stdout.trim(), "enabled" | "disabled");
            let state = if !known {
                "unknown"
            } else if active {
                "active"
            } else if enabled {
                "enabled"
            } else {
                "inactive"
            };
            TimerGate {
                unit: unit.to_string(),
                state: state.to_string(),
                blocked: state == "active" || state == "enabled",
                error: None,
            }
        };
        if let Ok(mut cache) = CACHE.lock() {
            cache.insert(unit.to_string(), (gate.clone(), now));
        }
        if let Ok(mut mutable) = self.mutable.lock() {
            mutable.timer_gate = Some(gate);
        }
    }

    async fn refresh_timer(&self, force: bool) {
        let Some(unit) = self.descriptor.timer_unit else {
            return;
        };
        let now = (self.now)();
        {
            let Ok(mut mutable) = self.mutable.lock() else {
                return;
            };
            if mutable.timer_reading {
                return;
            }
            if !force
                && mutable.timer_read_at != 0
                && now - mutable.timer_read_at < TIMER_REFRESH_MS
            {
                return;
            }
            mutable.timer_reading = true;
            mutable.timer_read_at = now;
        }
        let available = systemctl(&["is-active".to_string(), unit.to_string()]).await;
        let gate = if available.code == 127
            || available.stderr.contains("not found")
            || available.stderr.to_lowercase().contains("no such file")
        {
            Some(TimerGate {
                unit: unit.to_string(),
                state: "absent".to_string(),
                blocked: false,
                error: None,
            })
        } else {
            let active = available.stdout.trim() == "active";
            let enabled_result = systemctl(&["is-enabled".to_string(), unit.to_string()]).await;
            let enabled = enabled_result.stdout.trim() == "enabled";
            let known = matches!(available.stdout.trim(), "active" | "inactive")
                || matches!(enabled_result.stdout.trim(), "enabled" | "disabled");
            let state = if !known {
                "unknown"
            } else if active {
                "active"
            } else if enabled {
                "enabled"
            } else {
                "inactive"
            };
            Some(TimerGate {
                unit: unit.to_string(),
                state: state.to_string(),
                blocked: state == "active" || state == "enabled",
                error: None,
            })
        };
        if let Ok(mut mutable) = self.mutable.lock() {
            mutable.timer_gate = gate;
            mutable.timer_reading = false;
        }
    }

    async fn takeover(&self) {
        {
            let Ok(mut mutable) = self.mutable.lock() else {
                return;
            };
            if mutable.takeover {
                return;
            }
            mutable.takeover = true;
        }
        let owners: Vec<LockOwner> = self
            .owners()
            .into_iter()
            .filter(|owner| resolved(Path::new(&owner.state_dir)) == resolved(&self.state_dir))
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
        if self.spawn_worker().is_none() {
            return;
        }
        for owner in owners {
            if owner.harness_version == self.running_version {
                continue;
            }
            let _ = write_command(&self.control_for(&owner), &json!({"type": "drain"}));
        }
    }

    fn preview_start(&self) {
        if self.owners().is_empty() {
            if let Ok(mut mutable) = self.mutable.lock() {
                mutable.preview_starting = true;
                mutable.start_error = None;
                mutable.notice = None;
            }
        }
    }

    fn clear_preview(&self) {
        if let Ok(mut mutable) = self.mutable.lock() {
            mutable.preview_starting = false;
        }
    }

    async fn start(&self) -> AgentResult {
        let _guard = self.start_lock.lock().await;
        {
            let mut mutable = self.mutable.lock().expect("watchdog state");
            if mutable.start_pending {
                mutable.notice =
                    Some("Start did nothing: the Watchdog worker is already starting.".to_string());
                return AgentResult::ok();
            }
        }
        let owners = self.owners();
        if !owners.is_empty() {
            if let Some(foreign) = owners
                .iter()
                .find(|owner| resolved(Path::new(&owner.state_dir)) != resolved(&self.state_dir))
            {
                let notice = format!(
                    "Start did nothing: Watchdog is running for this root from another dashboard (STATE_DIR {}).",
                    foreign.state_dir
                );
                if let Ok(mut mutable) = self.mutable.lock() {
                    mutable.notice = Some(notice);
                }
                return AgentResult::ok();
            }
            let notice = format!(
                "Start did nothing: the Watchdog worker (pid {}) is already running for this root.",
                owners
                    .iter()
                    .map(|owner| owner.pid.to_string())
                    .collect::<Vec<String>>()
                    .join(", ")
            );
            if let Ok(mut mutable) = self.mutable.lock() {
                mutable.notice = Some(notice);
            }
            return AgentResult::ok();
        }
        {
            let mut mutable = self.mutable.lock().expect("watchdog state");
            mutable.start_pending = true;
            mutable.starting = true;
            mutable.starting_since = None;
            mutable.start_deadline = Some(start_deadline_at(
                (self.now)(),
                self.preflight_timeout_ms.load(Ordering::SeqCst).max(1),
            ));
            mutable.start_cancelled = false;
            mutable.start_error = None;
            mutable.notice = None;
        }
        let request = PreflightRequest {
            family: "watchdog".to_string(),
            repo_dir: self.repo_dir.clone(),
            state_dir: self.state_dir.clone(),
            environment: self.environment.clone(),
        };
        let override_preflight = self
            .preflight_override
            .lock()
            .ok()
            .and_then(|slot| slot.clone());
        let timeout_ms = self.preflight_timeout_ms.load(Ordering::SeqCst).max(1);
        let pending: Pin<Box<dyn Future<Output = Result<String, String>> + Send>> =
            match override_preflight {
                Some(callback) => callback(request),
                None => Box::pin(self.preflight_watchdog(PreflightBudget::new(timeout_ms))),
            };
        let result = match crate::deadline::within_deadline(pending, timeout_ms).await {
            Some(result) => result,
            None => Err(format!(
                "the start preflight did not finish within {timeout_ms} ms; press Start to retry."
            )),
        };
        let cancelled = self
            .mutable
            .lock()
            .map(|mutable| mutable.start_cancelled)
            .unwrap_or(false);
        if cancelled {
            self.end_start();
            return AgentResult::ok();
        }
        if let Err(message) = result {
            self.end_start();
            if let Ok(mut mutable) = self.mutable.lock() {
                let (start_error, notice) = start_refusal_fields(message.clone());
                mutable.start_error = start_error;
                mutable.notice = notice;
            }
            return AgentResult::failure(message);
        }
        {
            let mut mutable = self.mutable.lock().expect("watchdog state");
            mutable.starting = true;
            mutable.starting_since = Some((self.now)());
            mutable.start_deadline = None;
        }
        match self.spawn_worker() {
            Some(_) => {
                if let Ok(mut mutable) = self.mutable.lock() {
                    mutable.start_pending = false;
                    mutable.start_cancelled = false;
                }
                AgentResult::ok()
            }
            None => {
                self.end_start();
                let message = "the Watchdog worker could not be started".to_string();
                if let Ok(mut mutable) = self.mutable.lock() {
                    mutable.start_error = Some(message.clone());
                }
                AgentResult::failure(message)
            }
        }
    }

    fn end_start(&self) {
        if let Ok(mut mutable) = self.mutable.lock() {
            mutable.start_pending = false;
            mutable.starting = false;
            mutable.starting_since = None;
            mutable.start_deadline = None;
            mutable.start_cancelled = false;
        }
    }

    fn spawn_worker(&self) -> Option<u32> {
        let argv = harness_argv(
            "watchdog",
            &[
                ("repo", self.repo_dir.as_path()),
                ("state-dir", self.directory.as_path()),
                ("owner-state-dir", self.state_dir.as_path()),
            ],
        );
        let environment = provider_environment(
            &self.environment,
            &[("REPO_DIR", self.repo_dir.to_string_lossy().as_ref())],
        );
        let spawn = self.spawn.lock().map(|slot| slot.clone()).ok()?;
        spawn(&argv, environment)
    }

    fn stop(&self) -> AgentResult {
        let owners = self.owners();
        if owners.is_empty() {
            let start_pending = self
                .mutable
                .lock()
                .map(|mutable| mutable.start_pending)
                .unwrap_or(false);
            if start_pending {
                if let Ok(mut mutable) = self.mutable.lock() {
                    mutable.start_cancelled = true;
                    mutable.start_error = None;
                }
                return AgentResult::ok();
            }
            return AgentResult::failure(
                "No Watchdog worker is running for this root.".to_string(),
            );
        }
        if let Some(foreign) = owners
            .iter()
            .find(|owner| resolved(Path::new(&owner.state_dir)) != resolved(&self.state_dir))
        {
            return AgentResult::failure(format!(
                "Watchdog is running from another dashboard (STATE_DIR {}); this dashboard cannot stop it.",
                foreign.state_dir
            ));
        }
        for owner in &owners {
            if let Err(error) = write_command(&self.control_for(owner), &json!({"type": "stop"})) {
                return AgentResult::failure(format!("Could not reach the worker: {error}"));
            }
        }
        if let Ok(mut mutable) = self.mutable.lock() {
            mutable.stop_requested = true;
            mutable.start_error = None;
            mutable.notice = None;
        }
        self.schedule_stop_proof(owners.iter().map(|owner| owner.pid).collect());
        AgentResult::ok()
    }

    fn schedule_stop_proof(&self, pids: Vec<u32>) {
        if pids.is_empty() {
            return;
        }
        let directory = self.directory.clone();
        let mutable = Arc::clone(&self.mutable);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(STOP_CYCLE_GRACE_MS)).await;
            let signalled: Vec<u32> = pids
                .into_iter()
                .filter(|pid| {
                    let settled = !pid_alive(*pid)
                        || read_watchdog_worker_states(&directory)
                            .iter()
                            .any(|state| state.pid == *pid && state.lifecycle == "stopped");
                    if settled {
                        return false;
                    }
                    let argv = crate::supervision::process_argv(*pid).unwrap_or_default();
                    let proven = argv.iter().any(|entry| {
                        entry.ends_with("watchdog/worker.ts")
                            || (entry == "worker" && argv.iter().any(|value| value == "watchdog"))
                    });
                    proven
                })
                .collect();
            for pid in &signalled {
                unsafe {
                    libc::kill(*pid as i32, libc::SIGTERM);
                }
                if let Ok(mut mutable) = mutable.lock() {
                    mutable.stopping.insert(*pid);
                }
            }
            if signalled.is_empty() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(STOP_KILL_GRACE_MS)).await;
            for pid in signalled {
                let settled = !pid_alive(pid)
                    || read_watchdog_worker_states(&directory)
                        .iter()
                        .any(|state| state.pid == pid && state.lifecycle == "stopped");
                if settled {
                    continue;
                }
                unsafe {
                    libc::kill(pid as i32, libc::SIGKILL);
                }
            }
        });
    }

    fn set_settings(
        &self,
        minutes: Option<u64>,
        max_per_hour: Option<Value>,
        max_pending: Option<Value>,
    ) -> AgentResult {
        let Some(minutes) = minutes.filter(|value| (1..=1440).contains(value)) else {
            return AgentResult::failure(
                "The cadence must be an integer from 1 through 1440 minutes.".to_string(),
            );
        };
        let (Some(max_per_hour), Some(max_pending)) =
            (strict_limit(&max_per_hour), strict_limit(&max_pending))
        else {
            return AgentResult::failure(
                "Both limits must be empty or integers from 1 through 100.".to_string(),
            );
        };
        let settings = BasicSettings {
            interval_minutes: minutes as u32,
            max_per_hour,
            max_pending,
        };
        if let Err(error) = write_settings_atomically(
            &watchdog_settings_path(&self.directory),
            &settings.to_json_interval_first(),
        ) {
            return AgentResult::failure(format!("Could not save the settings: {error}"));
        }
        for owner in self
            .owners()
            .into_iter()
            .filter(|owner| resolved(Path::new(&owner.state_dir)) == resolved(&self.state_dir))
        {
            if let Err(error) = write_command(
                &self.control_for(&owner),
                &json!({
                    "type": "settings",
                    "intervalMinutes": minutes,
                    "maxPerHour": max_per_hour,
                    "maxPending": max_pending,
                }),
            ) {
                return AgentResult::failure(format!("Could not reach the worker: {error}"));
            }
        }
        if let Ok(mut mutable) = self.mutable.lock() {
            mutable.start_error = None;
        }
        AgentResult::ok()
    }

    async fn disable_timer(&self) -> AgentResult {
        let Some(unit) = self.descriptor.timer_unit else {
            return AgentResult::failure("This agent has no legacy timer.".to_string());
        };
        let result =
            systemctl(&["disable".to_string(), "--now".to_string(), unit.to_string()]).await;
        if result.code != 0 {
            let detail = first_line(if !result.stderr.is_empty() {
                &result.stderr
            } else {
                &result.stdout
            })
            .unwrap_or_else(|| format!("systemctl exited with code {}", result.code));
            let message = format!("could not disable {unit}: {detail}");
            if let Ok(mut mutable) = self.mutable.lock() {
                mutable.start_error = Some(message.clone());
                if let Some(timer) = mutable.timer_gate.as_mut() {
                    timer.error = Some(message.clone());
                }
            }
            return AgentResult::failure(message);
        }
        self.refresh_timer(true).await;
        AgentResult::ok()
    }

    async fn preflight_watchdog(&self, budget: PreflightBudget) -> Result<String, String> {
        if let Some(problem) = root_problem(&self.repo_dir) {
            return Err(problem);
        }
        let remote = origin_forge(&self.repo_dir, &self.environment).ok_or_else(|| {
            "the checkout's origin does not name a supported repository".to_string()
        })?;
        if remote.forge == "gitlab" {
            return Err(format!(
                "Watchdog supports a GitHub or Gitea origin, not a GitLab one: {}",
                remote.host
            ));
        }
        if remote.forge == "github" {
            if find_on_path("gh", &self.environment).is_none() {
                return Err("missing prerequisite: gh is not on PATH".to_string());
            }
            let permission = gh_command(
                &self.environment,
                &[
                    "api",
                    &format!("repos/{}", remote.project),
                    "--jq",
                    ".permissions.push",
                ],
                None,
            )
            .await?;
            if permission.code != 0 || permission.stdout.trim() != "true" {
                let detail = first_line(&permission.stderr)
                    .or_else(|| first_line(&permission.stdout))
                    .unwrap_or_else(|| format!("gh exited with code {}", permission.code));
                return Err(format!(
                    "missing prerequisite: 'gh api repos/{} --jq .permissions.push' did not return true: {detail}",
                    remote.project
                ));
            }
        } else {
            let (target, base_url) = gitea_preflight_target(&remote, &self.environment)?;
            let transport = crate::forge::default_transport(budget.remaining_ms());
            let document = gitea_repository_within(budget, &target, &transport).await?;
            let permissions = document.get("permissions").cloned().unwrap_or(Value::Null);
            let writable = permissions.get("push").and_then(Value::as_bool) == Some(true)
                || permissions.get("admin").and_then(Value::as_bool) == Some(true);
            if !writable {
                return Err(format!(
                    "missing prerequisite: the Gitea token cannot write to {} on {base_url}",
                    remote.project
                ));
            }
        }
        let active = systemctl(&[
            "is-active".to_string(),
            "devboard-watchdog.timer".to_string(),
        ])
        .await;
        let enabled = systemctl(&[
            "is-enabled".to_string(),
            "devboard-watchdog.timer".to_string(),
        ])
        .await;
        if active.stdout.trim() == "active" || enabled.stdout.trim() == "enabled" {
            return Err(
                "the legacy devboard-watchdog.timer is active or enabled; disable it before starting Watchdog"
                    .to_string(),
            );
        }
        Ok(remote.project)
    }
}

struct SystemctlOutcome {
    code: i32,
    stdout: String,
    stderr: String,
}

async fn systemctl(args: &[String]) -> SystemctlOutcome {
    let mut command = tokio::process::Command::new("systemctl");
    command
        .arg("--user")
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            return SystemctlOutcome {
                code: 127,
                stdout: String::new(),
                stderr: "systemctl: not found".to_string(),
            }
        }
    };
    let wait = child.wait_with_output();
    match tokio::time::timeout(Duration::from_millis(1_500), wait).await {
        Ok(Ok(output)) => SystemctlOutcome {
            code: output.status.code().unwrap_or(1),
            stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        },
        Ok(Err(error)) => SystemctlOutcome {
            code: 1,
            stdout: String::new(),
            stderr: error.to_string(),
        },
        Err(_) => SystemctlOutcome {
            code: 1,
            stdout: String::new(),
            stderr: "systemctl did not finish before its deadline".to_string(),
        },
    }
}

/* ------------------------------------------------------------------------ */
/* MCP optimizer                                                             */
/* ------------------------------------------------------------------------ */

fn mcp_optimizer_directory(state_dir: &Path) -> PathBuf {
    state_dir.join("coach")
}

#[derive(Clone, Debug)]
struct McpWorkerState {
    pid: u32,
    lifecycle: String,
    enabled: bool,
    last_run_at: Option<String>,
    next_run_at: Option<String>,
    last_error: Option<String>,
    notice: Option<String>,
    updated_at: String,
}

fn parse_mcp_worker_state(text: &str) -> Option<McpWorkerState> {
    let value: Value = serde_json::from_str(text).ok()?;
    let object = value.as_object()?;
    if object.get("version")?.as_u64()? != 1 {
        return None;
    }
    let pid = object.get("pid")?.as_u64()? as u32;
    if pid == 0 {
        return None;
    }
    let lifecycle = object.get("lifecycle")?.as_str()?;
    if !LIFECYCLES.contains(&lifecycle) {
        return None;
    }
    object.get("startedAt")?.as_str()?;
    object.get("root")?.as_str()?;
    object.get("stateDir")?.as_str()?;
    object.get("argv")?.as_array()?;
    object.get("updatedAt")?.as_str()?;
    Some(McpWorkerState {
        pid,
        lifecycle: lifecycle.to_string(),
        enabled: object.get("enabled")?.as_bool()?,
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
        updated_at: object.get("updatedAt")?.as_str()?.to_string(),
    })
}

fn read_mcp_worker_state(directory: &Path) -> Option<McpWorkerState> {
    parse_mcp_worker_state(&std::fs::read_to_string(directory.join("worker.json")).ok()?)
}

fn mcp_family_entries(directory: &Path) -> Vec<Value> {
    let ledger = read_json(&directory.join("state.json")).unwrap_or(Value::Null);
    let Some(families) = ledger.get("families").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut rows: Vec<Value> = families
        .iter()
        .filter_map(|(family, entry)| {
            let url = entry.get("lastIssueUrl").and_then(Value::as_str)?;
            let kind = entry
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("command");
            Some((
                json!({
                    "url": url,
                    "family": family,
                    "title": entry
                        .get("lastTitle")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("[mcp-optimizer] {family}")),
                    "kind": kind,
                    "filedAt": entry
                        .get("lastFiledAt")
                        .and_then(Value::as_str)
                        .or_else(|| entry.get("lastSeen").and_then(Value::as_str))
                        .unwrap_or(""),
                }),
                kind.to_string(),
            ))
        })
        .map(|(row, _)| row)
        .collect();
    rows.sort_by(|left, right| {
        let left_at = left.get("filedAt").and_then(Value::as_str).unwrap_or("");
        let right_at = right.get("filedAt").and_then(Value::as_str).unwrap_or("");
        right_at.cmp(left_at).then_with(|| {
            left.get("url")
                .and_then(Value::as_str)
                .unwrap_or("")
                .cmp(right.get("url").and_then(Value::as_str).unwrap_or(""))
        })
    });
    rows
}

fn mcp_pending(directory: &Path) -> u64 {
    read_json(&directory.join("state.json"))
        .and_then(|ledger| {
            ledger
                .get("pendingFiling")
                .and_then(Value::as_array)
                .map(Vec::len)
        })
        .unwrap_or(0) as u64
}

fn mcp_issue_url_for(directory: &Path, family: &str) -> Option<String> {
    read_json(&directory.join("state.json")).and_then(|ledger| {
        ledger
            .get("families")
            .and_then(Value::as_object)
            .and_then(|families| families.get(family))
            .and_then(|entry| entry.get("lastIssueUrl"))
            .and_then(Value::as_str)
            .map(str::to_string)
    })
}

fn mcp_status(
    directory: &Path,
) -> (
    Option<String>,
    String,
    u64,
    u64,
    u64,
    u64,
    u64,
    Vec<Value>,
    Vec<Value>,
) {
    let latest = latest_cycle_document(directory);
    let object = latest.as_object();
    let cycle = object
        .and_then(|object| object.get("cycle"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let action = object
        .and_then(|object| object.get("action"))
        .and_then(Value::as_str)
        .unwrap_or("none")
        .to_string();
    let families = object
        .and_then(|object| object.get("families"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let selected = object
        .and_then(|object| object.get("selected"))
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0) as u64;
    let filed = object
        .and_then(|object| object.get("issues"))
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0) as u64;
    let dropped = object
        .and_then(|object| object.get("dropped"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let issues = mcp_family_entries(directory);
    let pending = mcp_pending(directory);
    let resolve = |family: &str| mcp_issue_url_for(directory, family);
    let latest_cycle = cycle_from_report(&latest, &resolve);
    let cycles = read_cycles(directory, latest_cycle, &resolve);
    (
        cycle, action, families, selected, filed, dropped, pending, issues, cycles,
    )
}

struct McpMutable {
    preview_starting: bool,
    starting: bool,
    starting_since: Option<i64>,
    start_deadline: Option<i64>,
    stop_requested: bool,
    start_error: Option<String>,
    notice: Option<String>,
    stopping: HashSet<u32>,
    takeover: bool,
}

struct McpFamily {
    descriptor: &'static Descriptor,
    repo_dir: PathBuf,
    state_dir: PathBuf,
    directory: PathBuf,
    running_version: Option<String>,
    environment: HashMap<String, String>,
    spawn: SharedSpawn,
    preflight_override: SharedPreflight,
    preflight_timeout_ms: Arc<AtomicU64>,
    forge: ForgeProjection,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    mutable: Arc<Mutex<McpMutable>>,
    start_lock: tokio::sync::Mutex<()>,
}

impl McpFamily {
    fn new(
        repo_dir: &Path,
        state_dir: &Path,
        environment: &HashMap<String, String>,
        running_version: Option<String>,
        spawn: SharedSpawn,
        preflight_override: SharedPreflight,
        forge_reader: Option<ForgeReader>,
        now: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Self {
        let directory = mcp_optimizer_directory(state_dir);
        let seed: Vec<ForgeFact> = read_projection_issues(&directory)
            .into_iter()
            .map(|issue| ForgeFact {
                url: issue
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                state: issue
                    .get("state")
                    .and_then(Value::as_str)
                    .unwrap_or("pending")
                    .to_string(),
                version: issue
                    .get("version")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
            .collect();
        Self {
            descriptor: descriptor("mcp-optimizer").expect("mcp-optimizer descriptor"),
            repo_dir: repo_dir.to_path_buf(),
            state_dir: state_dir.to_path_buf(),
            directory,
            running_version,
            environment: environment.clone(),
            spawn,
            preflight_override,
            preflight_timeout_ms: Arc::new(AtomicU64::new(AGENT_PREFLIGHT_TIMEOUT_MS)),
            forge: ForgeProjection::new(forge_reader, seed),
            now,
            mutable: Arc::new(Mutex::new(McpMutable {
                preview_starting: false,
                starting: false,
                starting_since: None,
                start_deadline: None,
                stop_requested: false,
                start_error: None,
                notice: None,
                stopping: HashSet::new(),
                takeover: false,
            })),
            start_lock: tokio::sync::Mutex::new(()),
        }
    }

    fn lock_path(&self) -> PathBuf {
        self.directory.join("lock")
    }

    fn preflight_timeout_cell(&self) -> Arc<AtomicU64> {
        Arc::clone(&self.preflight_timeout_ms)
    }

    fn owners(&self) -> Vec<LockOwner> {
        live_lock_owners(&self.lock_path())
            .into_iter()
            .filter(|owner| resolved(Path::new(&owner.state_dir)) == resolved(&self.state_dir))
            .collect()
    }

    fn control_for(&self, owner: &LockOwner) -> PathBuf {
        let legacy = read_lock(&self.lock_path())
            .map(|value| value.pid == owner.pid)
            .unwrap_or(false);
        if legacy {
            return self.directory.join("control");
        }
        self.directory
            .join("workers")
            .join(worker_version_key(owner.harness_version.as_deref()))
            .join("control")
    }

    fn all_states(&self) -> Vec<McpWorkerState> {
        let mut states = Vec::new();
        if let Some(state) = read_mcp_worker_state(&self.directory) {
            states.push(state);
        }
        for directory in worker_state_directories(&self.directory) {
            if let Some(state) = read_mcp_worker_state(&directory) {
                states.push(state);
            }
        }
        states
    }

    fn forge_urls(&self) -> Vec<String> {
        mcp_family_entries(&self.directory)
            .into_iter()
            .filter_map(|issue| issue.get("url").and_then(Value::as_str).map(str::to_string))
            .collect()
    }

    fn poll_signature(&self) -> u64 {
        tree_signature(&self.directory)
    }

    fn rebuild_always(&self) -> bool {
        let Ok(mutable) = self.mutable.lock() else {
            return true;
        };
        mutable.starting
            || mutable.preview_starting
            || mutable.stop_requested
            || !mutable.stopping.is_empty()
    }

    fn snapshot(&self) -> Value {
        let now = (self.now)();
        if self.forge_urls().is_empty() {
            self.forge.note_empty_read(now);
        }
        let owners = self.owners();
        let states = self.all_states();
        let by_pid: HashMap<u32, McpWorkerState> = states
            .iter()
            .map(|state| (state.pid, state.clone()))
            .collect();
        let owner_states: Vec<Option<McpWorkerState>> = owners
            .iter()
            .map(|owner| by_pid.get(&owner.pid).cloned())
            .collect();
        let attached = owners.iter().enumerate().any(|(index, _)| {
            owner_states[index]
                .as_ref()
                .map(|state| state.lifecycle != "stopped")
                .unwrap_or(true)
        });
        let mut sorted_states = states.clone();
        sorted_states.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        let active = owner_states
            .iter()
            .flatten()
            .find(|state| state.lifecycle != "stopped")
            .cloned()
            .or_else(|| owner_states.iter().flatten().next().cloned())
            .or_else(|| sorted_states.first().cloned());
        {
            let Ok(mut mutable) = self.mutable.lock() else {
                return project_snapshot(self.descriptor, empty_repo_input(self.descriptor));
            };
            if (mutable.starting || mutable.preview_starting) && attached {
                // A worker is attached, so the start this preview announced has
                // happened: the preview never outlives its own Start.
                mutable.starting = false;
                mutable.starting_since = None;
                mutable.start_deadline = None;
                mutable.preview_starting = false;
            }
            if attached {
                mutable.start_error = None;
            }
            if mutable.starting
                && mutable
                    .start_deadline
                    .is_some_and(|deadline| now > deadline)
            {
                mutable.starting = false;
                mutable.starting_since = None;
                mutable.start_deadline = None;
                mutable.preview_starting = false;
                mutable.start_error = Some(
                    "the MCP optimizer start did not finish; press Start to retry.".to_string(),
                );
            }
            if mutable.starting {
                if let Some(since) = mutable.starting_since {
                    if now - since > START_PROOF_MS {
                        mutable.starting = false;
                        mutable.starting_since = None;
                        mutable.start_error = Some(
                            "the MCP optimizer worker did not publish its state within 5 seconds"
                                .to_string(),
                        );
                    }
                }
            }
            if mutable.stop_requested && !attached {
                mutable.stop_requested = false;
            }
            if !attached {
                mutable.stopping.clear();
            }
            if owners.is_empty()
                && !mutable.starting
                && !mutable.preview_starting
                && mutable
                    .notice
                    .as_deref()
                    .is_some_and(|notice| notice.starts_with("Start did nothing: the "))
            {
                mutable.notice = None;
            }
        }
        let mutable = self.mutable.lock().expect("mcp state");
        let settings = read_mcp_settings(&self.directory);
        let (
            status_cycle,
            _action,
            _families,
            _selected,
            _filed,
            _dropped,
            pending,
            status_issues,
            cycles,
        ) = mcp_status(&self.directory);
        let lifecycle = if mutable.starting || mutable.preview_starting {
            "starting".to_string()
        } else if mutable.stop_requested
            || active
                .as_ref()
                .map(|state| state.lifecycle == "stopping")
                .unwrap_or(false)
        {
            "stopping".to_string()
        } else if attached {
            if active
                .as_ref()
                .map(|state| state.lifecycle == "failed")
                .unwrap_or(false)
            {
                "failed".to_string()
            } else {
                "running".to_string()
            }
        } else if active
            .as_ref()
            .map(|state| state.lifecycle == "failed")
            .unwrap_or(false)
        {
            "failed".to_string()
        } else {
            "stopped".to_string()
        };
        let workers: Vec<Worker> = owners
            .iter()
            .map(|owner| Worker {
                pid: owner.pid,
                version: owner.harness_version.clone(),
                state_dir: owner.state_dir.clone(),
                lifecycle: by_pid
                    .get(&owner.pid)
                    .map(|state| state.lifecycle.clone())
                    .unwrap_or_else(|| "running".to_string()),
            })
            .collect();
        let issue_rows: Vec<Value> = status_issues
            .into_iter()
            .filter(|issue| {
                self.forge
                    .reported(issue.get("url").and_then(Value::as_str).unwrap_or(""))
            })
            .map(|issue| {
                let url = issue.get("url").and_then(Value::as_str).unwrap_or("");
                let fact = self.forge.fact(url);
                json!({
                    "title": issue.get("title").cloned().unwrap_or(Value::Null),
                    "category": issue.get("kind").cloned().unwrap_or(Value::Null),
                    "filedAt": issue.get("filedAt").cloned().unwrap_or(Value::Null),
                    "url": issue.get("url").cloned().unwrap_or(Value::Null),
                    "state": fact.as_ref().map(|fact| fact.state.clone()).unwrap_or_else(|| "unknown".to_string()),
                    "version": fact.and_then(|fact| fact.version),
                })
            })
            .collect();
        let last_run_at = active
            .as_ref()
            .and_then(|state| state.last_run_at.clone())
            .or(status_cycle);
        let enabled = attached
            && active.as_ref().map(|state| state.enabled).unwrap_or(false)
            && lifecycle != "stopped";
        project_snapshot(
            self.descriptor,
            SnapshotInput {
                lifecycle,
                paused: false,
                enabled,
                owned: attached,
                attached,
                minutes: settings.interval_minutes,
                last_run_at,
                next_run_at: if attached {
                    active.as_ref().and_then(|state| state.next_run_at.clone())
                } else {
                    None
                },
                limits: Limits {
                    max_per_hour: settings.max_per_hour,
                    max_pending: settings.max_pending,
                },
                issues: issue_rows,
                documentation: Vec::new(),
                releases: Vec::new(),
                pending,
                sync: self.forge.sync(now),
                detail: Detail::Cycles(cycles),
                notice: mutable
                    .notice
                    .clone()
                    .or_else(|| active.as_ref().and_then(|state| state.notice.clone())),
                error: mutable
                    .start_error
                    .clone()
                    .or_else(|| active.as_ref().and_then(|state| state.last_error.clone())),
                timer: None,
                workers,
            },
        )
    }

    async fn takeover(&self) {
        {
            let Ok(mut mutable) = self.mutable.lock() else {
                return;
            };
            if mutable.takeover {
                return;
            }
            mutable.takeover = true;
        }
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
        if !self.spawn_worker().await.ok {
            return;
        }
        for owner in owners {
            if owner.harness_version.as_deref() == Some(running_version.as_str()) {
                continue;
            }
            let _ = write_command(&self.control_for(&owner), &json!({"type": "drain"}));
        }
    }

    fn preview_start(&self) {
        if self.owners().is_empty() {
            if let Ok(mut mutable) = self.mutable.lock() {
                mutable.preview_starting = true;
                mutable.start_error = None;
                mutable.notice = None;
            }
        }
    }

    fn clear_preview(&self) {
        if let Ok(mut mutable) = self.mutable.lock() {
            mutable.preview_starting = false;
        }
    }

    async fn start(&self) -> AgentResult {
        let _guard = self.start_lock.lock().await;
        {
            let mut mutable = self.mutable.lock().expect("mcp state");
            if mutable.starting {
                mutable.notice = Some(
                    "Start did nothing: the MCP optimizer worker is already starting.".to_string(),
                );
                return AgentResult::ok();
            }
        }
        let owners = self.owners();
        if !owners.is_empty() {
            let notice = format!(
                "Start did nothing: the MCP optimizer worker (pid {}) is already running for this repository.",
                owners
                    .iter()
                    .map(|owner| owner.pid.to_string())
                    .collect::<Vec<String>>()
                    .join(", ")
            );
            if let Ok(mut mutable) = self.mutable.lock() {
                mutable.notice = Some(notice);
            }
            return AgentResult::ok();
        }
        self.spawn_worker().await
    }

    async fn spawn_worker(&self) -> AgentResult {
        {
            let mut mutable = self.mutable.lock().expect("mcp state");
            mutable.starting = true;
            mutable.starting_since = None;
            mutable.start_deadline = Some(start_deadline_at(
                (self.now)(),
                self.preflight_timeout_ms.load(Ordering::SeqCst).max(1),
            ));
            mutable.start_error = None;
            mutable.notice = None;
        }
        let request = PreflightRequest {
            family: "mcp-optimizer".to_string(),
            repo_dir: self.repo_dir.clone(),
            state_dir: self.state_dir.clone(),
            environment: self.environment.clone(),
        };
        let override_preflight = self
            .preflight_override
            .lock()
            .ok()
            .and_then(|slot| slot.clone());
        let timeout_ms = self.preflight_timeout_ms.load(Ordering::SeqCst).max(1);
        let pending: Pin<Box<dyn Future<Output = Result<String, String>> + Send>> =
            match override_preflight {
                Some(callback) => callback(request),
                None => Box::pin(self.preflight_mcp(PreflightBudget::new(timeout_ms))),
            };
        let result = match crate::deadline::within_deadline(pending, timeout_ms).await {
            Some(result) => result,
            None => Err(format!(
                "the start preflight did not finish within {timeout_ms} ms; press Start to retry."
            )),
        };
        if let Err(message) = result {
            let mut mutable = self.mutable.lock().expect("mcp state");
            mutable.starting = false;
            mutable.starting_since = None;
            let (start_error, notice) = start_refusal_fields(message.clone());
            mutable.start_error = start_error;
            mutable.notice = notice;
            return AgentResult::failure(message);
        }
        let argv = harness_argv(
            "mcp-optimizer",
            &[
                ("repo", self.repo_dir.as_path()),
                ("state-dir", self.state_dir.as_path()),
            ],
        );
        {
            let mut mutable = self.mutable.lock().expect("mcp state");
            mutable.starting = true;
            mutable.starting_since = Some((self.now)());
            mutable.start_deadline = None;
        }
        let environment = provider_environment(
            &self.environment,
            &[("REPO_DIR", self.repo_dir.to_string_lossy().as_ref())],
        );
        let spawn = self.spawn.lock().map(|slot| slot.clone()).ok();
        let pid = spawn.and_then(|spawn| spawn(&argv, environment));
        match pid {
            Some(_) => AgentResult::ok(),
            None => {
                let message = "the MCP optimizer worker could not be started".to_string();
                let mut mutable = self.mutable.lock().expect("mcp state");
                mutable.starting = false;
                mutable.starting_since = None;
                mutable.start_error = Some(message.clone());
                AgentResult::failure(message)
            }
        }
    }

    fn stop(&self) -> AgentResult {
        let owners = self.owners();
        if owners.is_empty() {
            return AgentResult::failure(
                "No MCP optimizer worker is running for this repository.".to_string(),
            );
        }
        let mut failures: Vec<String> = Vec::new();
        for owner in &owners {
            if let Err(error) = write_command(&self.control_for(owner), &json!({"type": "stop"})) {
                failures.push(error.to_string());
            }
            if let Ok(mut mutable) = self.mutable.lock() {
                mutable.stop_requested = true;
            }
            self.schedule_stop_proof(owner.pid);
        }
        if let Ok(mut mutable) = self.mutable.lock() {
            mutable.start_error = None;
            mutable.notice = None;
        }
        if failures.is_empty() {
            AgentResult::ok()
        } else {
            AgentResult::failure(format!(
                "Could not reach every worker: {}",
                failures.join("; ")
            ))
        }
    }

    fn schedule_stop_proof(&self, pid: u32) {
        {
            let mut mutable = self.mutable.lock().expect("mcp state");
            if !mutable.stopping.insert(pid) {
                return;
            }
        }
        let directory = self.directory.clone();
        let repo_dir = self.repo_dir.clone();
        let mutable = Arc::clone(&self.mutable);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(STOP_CYCLE_GRACE_MS)).await;
            if !pid_alive(pid) {
                return;
            }
            let state = read_mcp_worker_state(&directory)
                .into_iter()
                .chain(
                    worker_state_directories(&directory)
                        .into_iter()
                        .filter_map(|directory| read_mcp_worker_state(&directory)),
                )
                .find(|state| state.pid == pid);
            if state
                .map(|state| state.lifecycle == "stopped")
                .unwrap_or(false)
            {
                return;
            }
            let argv = crate::supervision::process_argv(pid).unwrap_or_default();
            let proven = argv.iter().any(|entry| {
                entry.ends_with("mcp-optimizer/worker.ts")
                    || (entry == "worker" && argv.iter().any(|value| value == "mcp-optimizer"))
            }) && argv.iter().any(|entry| Path::new(entry) == repo_dir);
            if !proven {
                return;
            }
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
            tokio::time::sleep(Duration::from_millis(STOP_KILL_GRACE_MS)).await;
            if !pid_alive(pid) {
                return;
            }
            let state = read_mcp_worker_state(&directory)
                .into_iter()
                .chain(
                    worker_state_directories(&directory)
                        .into_iter()
                        .filter_map(|directory| read_mcp_worker_state(&directory)),
                )
                .find(|state| state.pid == pid);
            if state
                .map(|state| state.lifecycle == "stopped")
                .unwrap_or(false)
            {
                return;
            }
            unsafe {
                libc::kill(pid as i32, libc::SIGKILL);
            }
            if let Ok(mut mutable) = mutable.lock() {
                mutable.stopping.remove(&pid);
            }
        });
    }

    fn set_settings(
        &self,
        minutes: Option<u64>,
        max_per_hour: Option<Value>,
        max_pending: Option<Value>,
    ) -> AgentResult {
        let Some(minutes) = minutes.filter(|value| (1..=1440).contains(value)) else {
            return AgentResult::failure(
                "The cadence must be an integer from 1 through 1440 minutes.".to_string(),
            );
        };
        let (Some(max_per_hour), Some(max_pending)) =
            (strict_limit(&max_per_hour), strict_limit(&max_pending))
        else {
            return AgentResult::failure(
                "Both limits must be empty or integers from 1 through 100.".to_string(),
            );
        };
        let mut settings = read_mcp_settings(&self.directory);
        settings.interval_minutes = minutes as u32;
        settings.max_per_hour = max_per_hour;
        settings.max_pending = max_pending;
        if let Err(error) =
            write_settings_atomically(&self.directory.join("settings.json"), &settings.to_json())
        {
            return AgentResult::failure(format!("Could not save the settings: {error}"));
        }
        let mut failures: Vec<String> = Vec::new();
        for owner in self.owners() {
            if let Err(error) = write_command(
                &self.control_for(&owner),
                &json!({
                    "type": "settings",
                    "intervalMinutes": minutes,
                    "maxPerHour": max_per_hour,
                    "maxPending": max_pending,
                }),
            ) {
                failures.push(error.to_string());
            }
        }
        if let Ok(mut mutable) = self.mutable.lock() {
            mutable.start_error = None;
        }
        if failures.is_empty() {
            AgentResult::ok()
        } else {
            AgentResult::failure(format!(
                "Could not reach every worker: {}",
                failures.join("; ")
            ))
        }
    }

    async fn preflight_mcp(&self, budget: PreflightBudget) -> Result<String, String> {
        let remote = {
            if let Some(problem) = root_problem(&self.repo_dir) {
                return Err(problem);
            }
            origin_forge(&self.repo_dir, &self.environment).ok_or_else(|| {
                "the checkout's origin does not name a supported repository".to_string()
            })?
        };
        if remote.forge == "gitlab" {
            return Err(format!(
                "MCP optimizer supports a GitHub or Gitea origin, not a GitLab one: {}",
                remote.host
            ));
        }
        if remote.forge == "github" {
            if find_on_path("gh", &self.environment).is_none() {
                return Err("missing prerequisite: gh is not on PATH".to_string());
            }
            let permission = gh_command(
                &self.environment,
                &[
                    "api",
                    &format!("repos/{}", remote.project),
                    "--jq",
                    ".permissions.push",
                ],
                None,
            )
            .await?;
            if permission.code != 0 || permission.stdout.trim() != "true" {
                let detail = first_line(&permission.stderr)
                    .or_else(|| first_line(&permission.stdout))
                    .unwrap_or_else(|| format!("gh exited with code {}", permission.code));
                return Err(format!(
                    "missing prerequisite: 'gh api repos/{} --jq .permissions.push' did not return true: {detail}",
                    remote.project
                ));
            }
            return Ok(remote.project);
        }
        let (target, base_url) = gitea_preflight_target(&remote, &self.environment)?;
        let transport = crate::forge::default_transport(budget.remaining_ms());
        let document = gitea_repository_within(budget, &target, &transport).await?;
        let permissions = document.get("permissions").cloned().unwrap_or(Value::Null);
        let writable = permissions.get("push").and_then(Value::as_bool) == Some(true)
            || permissions.get("admin").and_then(Value::as_bool) == Some(true);
        if !writable {
            return Err(format!(
                "missing prerequisite: the Gitea token cannot write to {} on {base_url}",
                remote.project
            ));
        }
        Ok(remote.project)
    }
}

fn read_projection_issues(directory: &Path) -> Vec<Value> {
    let projection = read_json(&directory.join("projection.json")).unwrap_or(Value::Null);
    if projection.get("version").and_then(Value::as_u64) != Some(1) {
        return Vec::new();
    }
    let Some(issues) = projection.get("issues").and_then(Value::as_array) else {
        return Vec::new();
    };
    issues
        .iter()
        .filter(|entry| {
            entry.get("url").and_then(Value::as_str).is_some()
                && matches!(
                    entry.get("state").and_then(Value::as_str),
                    Some("pending" | "implemented" | "unreadable")
                )
        })
        .cloned()
        .collect()
}

/* ------------------------------------------------------------------------ */
/* Release Train                                                             */
/* ------------------------------------------------------------------------ */

fn release_train_directory(state_dir: &Path) -> PathBuf {
    state_dir.join("release-train")
}

#[derive(Clone, Debug)]
struct ReleaseWorkerState {
    pid: u32,
    lifecycle: String,
    enabled: bool,
    paused: bool,
    last_run_at: Option<String>,
    next_run_at: Option<String>,
    last_error: Option<String>,
    notice: Option<String>,
    updated_at: String,
}

fn parse_release_worker_state(text: &str) -> Option<ReleaseWorkerState> {
    let value: Value = serde_json::from_str(text).ok()?;
    let object = value.as_object()?;
    if object.get("version")?.as_u64()? != 1 {
        return None;
    }
    let pid = object.get("pid")?.as_u64()? as u32;
    if pid == 0 {
        return None;
    }
    let lifecycle = object.get("lifecycle")?.as_str()?;
    if !LIFECYCLES.contains(&lifecycle) {
        return None;
    }
    object.get("startedAt")?.as_str()?;
    object.get("root")?.as_str()?;
    object.get("stateDir")?.as_str()?;
    object.get("argv")?.as_array()?;
    Some(ReleaseWorkerState {
        pid,
        lifecycle: lifecycle.to_string(),
        enabled: object.get("enabled")?.as_bool()?,
        paused: object.get("paused")?.as_bool()?,
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
        updated_at: object.get("updatedAt")?.as_str()?.to_string(),
    })
}

fn read_release_worker_state(directory: &Path) -> Option<ReleaseWorkerState> {
    parse_release_worker_state(&std::fs::read_to_string(directory.join("worker.json")).ok()?)
}

fn release_worker_states(directory: &Path) -> Vec<ReleaseWorkerState> {
    let mut states: Vec<ReleaseWorkerState> = worker_state_directories(directory)
        .into_iter()
        .filter_map(|directory| read_release_worker_state(&directory))
        .collect();
    states.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    states
}

fn release_settings(directory: &Path) -> BasicSettings {
    read_basic_settings(&directory.join("settings.json")).unwrap_or(BasicSettings {
        interval_minutes: 10,
        max_per_hour: None,
        max_pending: None,
    })
}

struct ReleaseMutable {
    preview_starting: bool,
    starting: bool,
    starting_since: Option<i64>,
    start_deadline: Option<i64>,
    stop_requested: bool,
    start_error: Option<String>,
    takeover: bool,
    /// Names a worker another dashboard's STATE_DIR owns, so a Start that
    /// cannot act on it says why instead of doing nothing.
    notice: Option<String>,
}

/// The notice a page reads while a worker of another dashboard's STATE_DIR owns
/// this root; the prefix is what a later snapshot clears.
const FOREIGN_WORKER_NOTICE: &str = "Release Train is running for this root from another dashboard";

fn foreign_worker_notice(state_dir: &str) -> String {
    format!("{FOREIGN_WORKER_NOTICE} (STATE_DIR {state_dir}).")
}

struct ReleaseFamily {
    descriptor: &'static Descriptor,
    repo_dir: PathBuf,
    state_dir: PathBuf,
    directory: PathBuf,
    running_version: Option<String>,
    environment: HashMap<String, String>,
    spawn: SharedSpawn,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    mutable: Arc<Mutex<ReleaseMutable>>,
    start_lock: tokio::sync::Mutex<()>,
}

impl ReleaseFamily {
    fn new(
        repo_dir: &Path,
        state_dir: &Path,
        environment: &HashMap<String, String>,
        running_version: Option<String>,
        spawn: SharedSpawn,
        now: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Self {
        Self {
            descriptor: descriptor("release-train").expect("release-train descriptor"),
            repo_dir: repo_dir.to_path_buf(),
            state_dir: state_dir.to_path_buf(),
            directory: release_train_directory(state_dir),
            running_version,
            environment: environment.clone(),
            spawn,
            now,
            mutable: Arc::new(Mutex::new(ReleaseMutable {
                preview_starting: false,
                starting: false,
                starting_since: None,
                start_deadline: None,
                stop_requested: false,
                start_error: None,
                takeover: false,
                notice: None,
            })),
            start_lock: tokio::sync::Mutex::new(()),
        }
    }

    /// Every live Release Train worker for this root, whichever dashboard's
    /// STATE_DIR started it. A worker of another STATE_DIR still holds the
    /// root's release cadence, so the page reads it as running.
    fn all_owners(&self) -> Vec<LockOwner> {
        live_lock_owners(&self.directory.join("lock"))
    }

    /// The live workers this dashboard may signal: the ones its own STATE_DIR
    /// started.
    fn owners(&self) -> Vec<LockOwner> {
        self.all_owners()
            .into_iter()
            .filter(|owner| self.owns(owner))
            .collect()
    }

    /// A live worker another dashboard's STATE_DIR owns, which this one cannot
    /// stop and must not start a second of.
    fn foreign_owner(&self) -> Option<LockOwner> {
        self.all_owners()
            .into_iter()
            .find(|owner| !self.owns(owner))
    }

    fn owns(&self, owner: &LockOwner) -> bool {
        resolved(Path::new(&owner.state_dir)) == resolved(&self.state_dir)
    }

    fn control_for(&self, owner: &LockOwner) -> PathBuf {
        self.directory
            .join("workers")
            .join(worker_version_key(owner.harness_version.as_deref()))
            .join("control")
    }

    fn poll_signature(&self) -> u64 {
        tree_signature(&self.directory)
    }

    fn rebuild_always(&self) -> bool {
        let Ok(mutable) = self.mutable.lock() else {
            return true;
        };
        mutable.starting || mutable.preview_starting || mutable.stop_requested
    }

    fn snapshot(&self) -> Value {
        let now = (self.now)();
        let shared = read_json(&self.directory.join("state.json")).unwrap_or(Value::Null);
        let owners = self.all_owners();
        let own: Vec<LockOwner> = owners
            .iter()
            .filter(|owner| self.owns(owner))
            .cloned()
            .collect();
        let foreign = owners.iter().find(|owner| !self.owns(owner)).cloned();
        let records = release_worker_states(&self.directory);
        let published = |owners: &[LockOwner]| {
            owners.iter().any(|owner| {
                records
                    .iter()
                    .any(|record| record.pid == owner.pid && record.lifecycle != "stopped")
            })
        };
        let attached = published(&owners);
        let owned = published(&own);
        let active = records
            .iter()
            .find(|record| {
                owners
                    .iter()
                    .any(|owner| owner.pid == record.pid && record.lifecycle != "stopped")
            })
            .cloned()
            .or_else(|| records.first().cloned());
        {
            let Ok(mut mutable) = self.mutable.lock() else {
                return project_snapshot(self.descriptor, empty_repo_input(self.descriptor));
            };
            if (mutable.starting || mutable.preview_starting) && attached {
                // A worker is attached, so the start this preview announced has
                // happened: the preview never outlives its own Start.
                mutable.starting = false;
                mutable.starting_since = None;
                mutable.start_deadline = None;
                mutable.preview_starting = false;
            }
            if attached {
                // A worker that published late is running; the five-second proof
                // error described its publication, not its life.
                mutable.start_error = None;
            }
            if mutable.starting
                && mutable
                    .start_deadline
                    .is_some_and(|deadline| now > deadline)
            {
                mutable.starting = false;
                mutable.starting_since = None;
                mutable.start_deadline = None;
                mutable.preview_starting = false;
                mutable.start_error = Some(
                    "the Release Train start did not finish; press Start to retry.".to_string(),
                );
            }
            if mutable.starting {
                if let Some(since) = mutable.starting_since {
                    if now - since > START_PROOF_MS {
                        mutable.starting = false;
                        mutable.starting_since = None;
                        mutable.start_error = Some(
                            "the Release Train worker did not publish its state within 5 seconds"
                                .to_string(),
                        );
                    }
                }
            }
            if mutable.stop_requested && own.is_empty() {
                mutable.stop_requested = false;
            }
            if let Some(foreign) = foreign.as_ref() {
                if !mutable.notice.as_deref().is_some_and(is_start_refusal) {
                    mutable.notice = Some(foreign_worker_notice(&foreign.state_dir));
                }
            } else if mutable
                .notice
                .as_ref()
                .map(|notice| {
                    notice.starts_with(FOREIGN_WORKER_NOTICE)
                        || notice.starts_with(
                            "Start did nothing: Release Train is running for this root from another dashboard",
                        )
                })
                .unwrap_or(false)
            {
                mutable.notice = None;
            }
            if own.is_empty()
                && !mutable.starting
                && !mutable.preview_starting
                && mutable
                    .notice
                    .as_deref()
                    .is_some_and(|notice| notice.starts_with("Start did nothing: the "))
            {
                mutable.notice = None;
            }
        }
        let mutable = self.mutable.lock().expect("release-train state");
        let settings = release_settings(&self.directory);
        let lifecycle = if mutable.starting || mutable.preview_starting {
            "starting".to_string()
        } else if mutable.stop_requested
            || active
                .as_ref()
                .map(|record| record.lifecycle == "stopping")
                .unwrap_or(false)
        {
            "stopping".to_string()
        } else if attached {
            if active
                .as_ref()
                .map(|record| record.lifecycle == "failed")
                .unwrap_or(false)
            {
                "failed".to_string()
            } else {
                "running".to_string()
            }
        } else if active
            .as_ref()
            .map(|record| record.lifecycle == "failed")
            .unwrap_or(false)
        {
            "failed".to_string()
        } else {
            "stopped".to_string()
        };
        let activity: Vec<String> = shared
            .get("activity")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|entry| entry.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let runs: Vec<Value> = shared
            .get("runs")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let latest_run = runs.first().cloned();
        let gate = shared.get("gate").cloned().unwrap_or(Value::Null);
        let workers: Vec<Worker> = owners
            .iter()
            .map(|owner| Worker {
                pid: owner.pid,
                version: owner.harness_version.clone(),
                state_dir: owner.state_dir.clone(),
                lifecycle: records
                    .iter()
                    .find(|record| record.pid == owner.pid)
                    .map(|record| record.lifecycle.clone())
                    .unwrap_or_else(|| "running".to_string()),
            })
            .collect();
        let releases = crate::workers::release_train::release_history(&self.directory, &shared);
        let gate_state = gate.get("state").and_then(Value::as_str);
        let gate_detail = gate.get("detail").and_then(Value::as_str);
        let sync = match gate_state {
            None | Some("") => AgentSync::stale(),
            Some("error") => AgentSync {
                state: "error".to_string(),
                at: gate.get("at").and_then(Value::as_str).map(str::to_string),
                error: gate_detail.map(str::to_string),
            },
            Some(_) => AgentSync {
                state: "ok".to_string(),
                at: gate.get("at").and_then(Value::as_str).map(str::to_string),
                error: None,
            },
        };
        let error = mutable
            .start_error
            .clone()
            .or_else(|| {
                if gate_state == Some("error") {
                    gate_detail.map(str::to_string)
                } else {
                    None
                }
            })
            .or_else(|| active.as_ref().and_then(|record| record.last_error.clone()))
            .or_else(|| {
                shared
                    .get("failure")
                    .and_then(|failure| failure.get("detail"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            });
        let scan_id = format!(
            "{}:{}",
            latest_run
                .as_ref()
                .and_then(|run| run.get("id"))
                .and_then(Value::as_str)
                .unwrap_or("idle"),
            activity.len()
        );
        project_snapshot(
            self.descriptor,
            SnapshotInput {
                lifecycle: lifecycle.clone(),
                paused: active.as_ref().map(|record| record.paused).unwrap_or(false),
                enabled: attached
                    && active
                        .as_ref()
                        .map(|record| record.enabled)
                        .unwrap_or(false)
                    && lifecycle != "stopped",
                owned,
                attached,
                minutes: settings.interval_minutes,
                last_run_at: active
                    .as_ref()
                    .and_then(|record| record.last_run_at.clone())
                    .or_else(|| {
                        shared
                            .get("release")
                            .and_then(|release| release.get("at"))
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    }),
                next_run_at: if attached {
                    active
                        .as_ref()
                        .and_then(|record| record.next_run_at.clone())
                } else {
                    None
                },
                limits: Limits {
                    max_per_hour: settings.max_per_hour,
                    max_pending: settings.max_pending,
                },
                issues: Vec::new(),
                documentation: Vec::new(),
                releases,
                pending: 0,
                sync,
                detail: Detail::Activity {
                    scan_id: Some(scan_id),
                    entries: activity,
                },
                notice: mutable
                    .notice
                    .clone()
                    .or_else(|| active.as_ref().and_then(|record| record.notice.clone())),
                error,
                timer: None,
                workers,
            },
        )
    }

    fn request_sync(&self) {
        for owner in self.owners() {
            let _ = write_command(&self.control_for(&owner), &json!({"type": "check"}));
        }
    }

    fn preview_start(&self) {
        if self.owners().is_empty() {
            if let Ok(mut mutable) = self.mutable.lock() {
                mutable.preview_starting = true;
                mutable.start_error = None;
                mutable.notice = None;
            }
        }
    }

    fn clear_preview(&self) {
        if let Ok(mut mutable) = self.mutable.lock() {
            mutable.preview_starting = false;
        }
    }

    async fn start(&self) -> AgentResult {
        let _guard = self.start_lock.lock().await;
        {
            let mut mutable = self.mutable.lock().expect("release state");
            if mutable.starting {
                mutable.notice = Some(
                    "Start did nothing: the Release Train worker is already starting.".to_string(),
                );
                return AgentResult::ok();
            }
        }
        if let Some(foreign) = self.foreign_owner() {
            // Another dashboard owns the root's cadence; a second worker would
            // compete for the same release. Start is a no-op that says so.
            let notice = format!(
                "Start did nothing: {}",
                foreign_worker_notice(&foreign.state_dir)
            );
            if let Ok(mut mutable) = self.mutable.lock() {
                mutable.notice = Some(notice);
                mutable.start_error = None;
            }
            return AgentResult::ok();
        }
        let owners = self.owners();
        if owners.is_empty() {
            return self.spawn_worker().await;
        }
        if owners
            .iter()
            .any(|owner| owner.harness_version == self.running_version)
        {
            let notice = format!(
                "Start did nothing: the Release Train worker (pid {}) is already running for this dashboard.",
                owners
                    .iter()
                    .map(|owner| owner.pid.to_string())
                    .collect::<Vec<String>>()
                    .join(", ")
            );
            if let Ok(mut mutable) = self.mutable.lock() {
                mutable.notice = Some(notice);
            }
            return AgentResult::ok();
        }
        self.takeover().await
    }

    async fn takeover(&self) -> AgentResult {
        {
            let Ok(mut mutable) = self.mutable.lock() else {
                return AgentResult::failure("the dashboard is stopping".to_string());
            };
            if mutable.takeover {
                return AgentResult::ok();
            }
            mutable.takeover = true;
        }
        let owners = self.owners();
        if owners.is_empty() {
            return AgentResult::failure(
                "No Release Train worker is running for this repository.".to_string(),
            );
        }
        if owners
            .iter()
            .any(|owner| owner.harness_version == self.running_version)
        {
            return AgentResult::ok();
        }
        let newest = self.running_version.as_ref().and_then(|_| {
            crate::version::read_harness_version(&crate::version::host_harness_dir(&self.repo_dir))
        });
        let refusal = |owners: &[LockOwner], newest: Option<&str>| -> String {
            let running = owners
                .iter()
                .map(|owner| {
                    owner
                        .harness_version
                        .clone()
                        .unwrap_or_else(|| "an unversioned harness".to_string())
                })
                .collect::<Vec<String>>()
                .join(", ");
            match (&self.running_version, newest) {
                (None, _) => format!(
                    "A Release Train worker of version {running} is running, and this dashboard does not know its own harness version, so it cannot take the worker over."
                ),
                (Some(_), None) => format!(
                    "A Release Train worker of version {running} is running, and the harness version under this repository could not be read, so this {} dashboard cannot take the worker over.",
                    self.running_version.as_deref().unwrap_or("")
                ),
                (Some(version), Some(newest)) => format!(
                    "A Release Train worker of version {running} is running, and the newest harness here is {newest}, so this {version} dashboard cannot take the worker over."
                ),
            }
        };
        if self.running_version.is_none() || newest.as_deref() != self.running_version.as_deref() {
            return AgentResult::failure(refusal(&owners, newest.as_deref()));
        }
        let started = self.spawn_worker().await;
        if !started.ok {
            return started;
        }
        for owner in owners {
            let _ = write_command(&self.control_for(&owner), &json!({"type": "drain"}));
        }
        AgentResult::ok()
    }

    async fn spawn_worker(&self) -> AgentResult {
        let problem = root_problem(&self.repo_dir);
        if let Some(problem) = problem {
            if let Ok(mut mutable) = self.mutable.lock() {
                mutable.start_error = Some(problem.clone());
            }
            return AgentResult::failure(problem);
        }
        {
            let mut mutable = self.mutable.lock().expect("release state");
            mutable.starting = true;
            mutable.starting_since = None;
            mutable.start_deadline =
                Some(start_deadline_at((self.now)(), AGENT_PREFLIGHT_TIMEOUT_MS));
            mutable.start_error = None;
        }
        let argv = harness_argv(
            "release-train",
            &[
                ("repo", self.repo_dir.as_path()),
                ("state-dir", self.state_dir.as_path()),
            ],
        );
        {
            let mut mutable = self.mutable.lock().expect("release state");
            mutable.starting = true;
            mutable.starting_since = Some((self.now)());
            mutable.start_deadline = None;
        }
        let mut environment = provider_environment(
            &self.environment,
            &[("REPO_DIR", self.repo_dir.to_string_lossy().as_ref())],
        );
        if let Some(version) = self.running_version.as_ref() {
            environment.insert("DEVBOARD_HARNESS_VERSION".to_string(), version.clone());
        }
        let spawn = self.spawn.lock().map(|slot| slot.clone()).ok();
        let pid = spawn.and_then(|spawn| spawn(&argv, environment));
        match pid {
            Some(_) => AgentResult::ok(),
            None => {
                let message = "the Release Train worker could not be started".to_string();
                let mut mutable = self.mutable.lock().expect("release state");
                mutable.starting = false;
                mutable.starting_since = None;
                mutable.start_error = Some(message.clone());
                AgentResult::failure(message)
            }
        }
    }

    fn stop(&self) -> AgentResult {
        let owners = self.owners();
        if owners.is_empty() {
            if let Some(foreign) = self.foreign_owner() {
                return AgentResult::failure(format!(
                    "Release Train is running from another dashboard (STATE_DIR {}); this dashboard cannot stop it.",
                    foreign.state_dir
                ));
            }
            return AgentResult::failure(
                "No Release Train worker is running for this repository.".to_string(),
            );
        }
        let mut failures: Vec<String> = Vec::new();
        for owner in &owners {
            if let Err(error) = write_command(&self.control_for(owner), &json!({"type": "stop"})) {
                failures.push(error.to_string());
            } else if let Ok(mut mutable) = self.mutable.lock() {
                mutable.stop_requested = true;
            }
        }
        if let Ok(mut mutable) = self.mutable.lock() {
            mutable.start_error = None;
            mutable.notice = None;
        }
        if failures.is_empty() {
            AgentResult::ok()
        } else {
            AgentResult::failure(format!(
                "Could not reach every worker: {}",
                failures.join("; ")
            ))
        }
    }

    fn set_settings(
        &self,
        minutes: Option<u64>,
        max_per_hour: Option<Value>,
        max_pending: Option<Value>,
    ) -> AgentResult {
        let Some(minutes) = minutes.filter(|value| (1..=1440).contains(value)) else {
            return AgentResult::failure(
                "The cadence must be an integer from 1 through 1440 minutes.".to_string(),
            );
        };
        let (Some(max_per_hour), Some(max_pending)) =
            (strict_limit(&max_per_hour), strict_limit(&max_pending))
        else {
            return AgentResult::failure(
                "Both limits must be empty or integers from 1 through 100.".to_string(),
            );
        };
        let settings = BasicSettings {
            interval_minutes: minutes as u32,
            max_per_hour,
            max_pending,
        };
        if let Err(error) = write_settings_atomically(
            &self.directory.join("settings.json"),
            &settings.to_json_interval_first(),
        ) {
            return AgentResult::failure(format!("Could not save the settings: {error}"));
        }
        let mut failures: Vec<String> = Vec::new();
        for owner in self.owners() {
            if let Err(error) = write_command(
                &self.control_for(&owner),
                &json!({
                    "type": "settings",
                    "intervalMinutes": minutes,
                    "maxPerHour": max_per_hour,
                    "maxPending": max_pending,
                }),
            ) {
                failures.push(error.to_string());
            }
        }
        if failures.is_empty() {
            AgentResult::ok()
        } else {
            AgentResult::failure(format!(
                "Could not reach every worker: {}",
                failures.join("; ")
            ))
        }
    }
}

#[cfg(test)]
mod forge_tests {
    use super::*;

    fn projection(seed: Vec<ForgeFact>) -> ForgeProjection {
        ForgeProjection::new(None, seed)
    }

    fn fact(url: &str) -> ForgeFact {
        ForgeFact {
            url: url.to_string(),
            state: "pending".to_string(),
            version: None,
        }
    }

    #[test]
    fn a_seeded_row_is_never_ok_before_a_completed_read() {
        let projection = projection(vec![fact("https://example.test/1")]);
        let sync = projection.sync(1_000);
        assert_eq!(sync.state, "stale");
        assert_eq!(sync.at, None);
    }

    #[test]
    fn a_known_row_turns_stale_after_the_interval_without_a_read() {
        let mut projection = projection(vec![fact("https://example.test/1")]);
        projection.stale_after_ms = 2_000;
        projection.apply(
            vec!["https://example.test/1".to_string()],
            vec![fact("https://example.test/1")],
            10_000,
        );
        assert_eq!(projection.sync(11_000).state, "ok");
        assert_eq!(projection.sync(12_001).state, "stale");
    }

    #[test]
    fn a_transient_failure_stays_stale_until_the_fifth_attempt() {
        let projection = projection(Vec::new());
        for attempt in 1..=4 {
            projection.fail("timed out".to_string(), 1_000 * attempt);
            assert_eq!(projection.sync(1_000 * attempt).state, "stale");
        }
        projection.fail("timed out".to_string(), 5_000);
        let sync = projection.sync(5_000);
        assert_eq!(sync.state, "error");
        assert_eq!(sync.error.as_deref(), Some("timed out"));
    }

    #[test]
    fn a_permanent_failure_surfaces_on_the_first_attempt() {
        let projection = projection(Vec::new());
        projection.fail("bad credentials".to_string(), 1_000);
        let sync = projection.sync(1_000);
        assert_eq!(sync.state, "error");
        assert_eq!(sync.error.as_deref(), Some("bad credentials"));
    }
}

#[cfg(test)]
mod gitea_preflight_tests {
    use super::*;
    use crate::forge::{HttpError, HttpFuture, HttpRequest, HttpResponse, Transport};
    use std::sync::atomic::AtomicUsize;

    /// A target as `gitea_preflight_target` builds it from a resolved remote.
    fn target() -> crate::forge::GiteaTarget {
        crate::forge::GiteaTarget {
            base_url: "http://forge.test".to_string(),
            project: "acme/fixture".to_string(),
            token: Some("token".to_string()),
        }
    }

    /// A transport that answers each call from `answers` in order and counts
    /// the requests it saw.
    fn transport(
        answers: Vec<Result<HttpResponse, HttpError>>,
    ) -> (Transport, Arc<AtomicUsize>, Arc<Mutex<Vec<String>>>) {
        let seen = Arc::new(AtomicUsize::new(0));
        let urls = Arc::new(Mutex::new(Vec::new()));
        let counter = Arc::clone(&seen);
        let recorded = Arc::clone(&urls);
        let answers = Arc::new(Mutex::new(answers));
        let transport: Transport = Arc::new(move |request: HttpRequest| {
            let index = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            recorded.lock().expect("urls").push(request.url.clone());
            let answer = answers
                .lock()
                .expect("answers")
                .get(index)
                .cloned()
                .unwrap_or_else(|| Ok(json_response(200, &json!({}))));
            Box::pin(async move { answer }) as HttpFuture
        });
        (transport, seen, urls)
    }

    fn json_response(status: u16, body: &Value) -> HttpResponse {
        HttpResponse {
            status,
            headers: Vec::new(),
            body: body.to_string().into_bytes(),
        }
    }

    fn repository(payload: Value) -> Result<HttpResponse, HttpError> {
        Ok(json_response(200, &payload))
    }

    #[tokio::test]
    async fn a_writable_repository_passes_through_the_shared_client() {
        let (transport, calls, urls) =
            transport(vec![repository(json!({"permissions": {"push": true}}))]);
        let document = gitea_repository_within(PreflightBudget::new(5_000), &target(), &transport)
            .await
            .expect("a writable repository");
        assert_eq!(document["permissions"]["push"], json!(true));
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(
            urls.lock().expect("urls").as_slice(),
            ["http://forge.test/api/v1/repos/acme/fixture"]
        );
    }

    #[tokio::test]
    async fn a_locked_token_table_refusal_is_retried_inside_the_budget() {
        let refusal = Ok(json_response(
            401,
            &json!({"message": "invalid username, password or token"}),
        ));
        let (transport, calls, _) = transport(vec![
            refusal,
            repository(json!({"permissions": {"push": true}})),
        ]);
        let document = gitea_repository_within(PreflightBudget::new(5_000), &target(), &transport)
            .await
            .expect("the second attempt reads the repository");
        assert_eq!(document["permissions"]["push"], json!(true));
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_stalled_read_names_the_request_and_is_not_a_missing_prerequisite() {
        let (transport, _, _) = transport(vec![Err(HttpError::Timeout)]);
        let error = gitea_repository_within(PreflightBudget::new(400), &target(), &transport)
            .await
            .expect_err("a stalled read refuses");
        assert!(
            error.starts_with("the Gitea repository acme/fixture could not be read before Start's deadline: GET /repos/acme/fixture failed: the request timed out after "),
            "{error}"
        );
        assert!(error.ends_with("; press Start to retry."), "{error}");
    }

    #[tokio::test]
    async fn a_missing_repository_stays_a_missing_prerequisite() {
        let (transport, calls, _) = transport(vec![Ok(json_response(
            404,
            &json!({"message": "not found"}),
        ))]);
        let error = gitea_repository_within(PreflightBudget::new(5_000), &target(), &transport)
            .await
            .expect_err("a missing repository refuses");
        assert!(
            error.starts_with(
                "missing prerequisite: the Gitea repository acme/fixture could not be read: GET /repos/acme/fixture failed (HTTP 404): not found"
            ),
            "{error}"
        );
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_fast_label_refusal_is_retried_inside_the_budget() {
        let (transport, calls, urls) = transport(vec![
            Ok(json_response(
                503,
                &json!({"message": "service unavailable"}),
            )),
            Ok(json_response(200, &json!([{"id": 7, "name": "dead-code"}]))),
            Ok(json_response(200, &json!([]))),
        ]);
        let labels = gitea_labels_within(PreflightBudget::new(5_000), &target(), &transport)
            .await
            .expect("the second attempt reads the labels");
        assert_eq!(labels.len(), 1);
        assert_eq!(labels[0].name, "dead-code");
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 3);
        assert_eq!(
            urls.lock().expect("urls").as_slice(),
            [
                "http://forge.test/api/v1/repos/acme/fixture/labels?limit=50&page=1",
                "http://forge.test/api/v1/repos/acme/fixture/labels?limit=50&page=1",
                "http://forge.test/api/v1/repos/acme/fixture/labels?limit=50&page=2",
            ]
        );
    }

    #[tokio::test]
    async fn a_stalled_label_read_answers_the_bounded_refusal() {
        let (transport, _, _) = transport(vec![Err(HttpError::Timeout)]);
        let error = gitea_labels_within(PreflightBudget::new(400), &target(), &transport)
            .await
            .expect_err("a stalled label read refuses");
        assert!(
            error.starts_with("the labels of acme/fixture could not be read before Start's deadline: GET /repos/acme/fixture/labels?limit=50&page=1 failed: the request timed out after "),
            "{error}"
        );
        assert!(error.ends_with("; press Start to retry."), "{error}");
    }

    #[tokio::test]
    async fn a_missing_label_list_stays_a_missing_prerequisite() {
        let (transport, calls, _) = transport(vec![Ok(json_response(
            404,
            &json!({"message": "not found"}),
        ))]);
        let error = gitea_labels_within(PreflightBudget::new(5_000), &target(), &transport)
            .await
            .expect_err("a missing label list refuses");
        assert!(
            error.starts_with(
                "missing prerequisite: the labels of acme/fixture could not be read: GET /repos/acme/fixture/labels?limit=50&page=1 failed (HTTP 404): not found"
            ),
            "{error}"
        );
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
}

#[cfg(test)]
mod state_tree_walks {
    //! A Start's answer frame is the family's projection, so the state-tree
    //! read behind it decides the action's latency. One projection answers
    //! from one walk: a second walk for the forge's URL set doubled the
    //! dominant term of the answer and pushed `startAgent` towards the
    //! client's one-second budget on a populated checkout.

    use super::*;

    fn fixture_root(label: &str) -> PathBuf {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!("state-walks-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("repo")).expect("a fixture repo");
        std::fs::create_dir_all(root.join("state")).expect("a fixture state");
        root
    }

    /// One family whose state tree holds `versions` worker state documents,
    /// each carrying one issue of its own.
    fn family_with_versions(label: &str, versions: usize) -> RepoFamily {
        let root = fixture_root(label);
        let state_dir = root.join("state");
        let repo_dir = root.join("repo");
        let family_dir = state_dir
            .join("scout")
            .join(crate::journal::journal_key(&repo_dir));
        for index in 0..versions {
            let directory = family_dir.join("workers").join(format!("1.{index}.0"));
            std::fs::create_dir_all(&directory).expect("a version directory");
            std::fs::write(directory.join("state.json"), state_document(index))
                .expect("a state document");
        }
        let spawn: SpawnFn =
            Arc::new(|_argv: &[String], _environment: HashMap<String, String>| None);
        let environment: Arc<AgentEnvironment> =
            Arc::new(|| Box::pin(async { Ok(HashMap::new()) }));
        RepoFamily::new(
            RepoFamilyId::Scout,
            &repo_dir,
            &state_dir,
            &HashMap::new(),
            "true",
            None,
            Arc::new(Mutex::new(environment)),
            Arc::new(Mutex::new(spawn)),
            Arc::new(Mutex::new(None)),
            None,
            Arc::new(|| 0),
        )
    }

    fn state_document(index: usize) -> String {
        json!({
            "version": 2,
            "repo": "owner/repository",
            "root": "/fixture",
            "lifecycle": "stopped",
            "enabled": false,
            "worker": Value::Null,
            "limits": {"maxPerHour": 50, "maxPending": 5},
            "intervalMinutes": 15,
            "issues": [{
                "number": index + 1,
                "title": format!("An issue {index}"),
                "url": format!("http://forge.invalid/issues/{}", index + 1),
                "createdAt": "2026-11-02T22:40:15+01:00",
                "state": "pending",
                "category": "clarity",
                "version": Value::Null,
                "versionAttemptAt": Value::Null,
                "versionError": Value::Null,
            }],
            "openTitles": [],
            "sync": {"state": "ok", "at": "2026-11-02T21:42:09.881Z", "error": Value::Null},
            "newestScanId": Value::Null,
            "nextAttemptAt": Value::Null,
            "lastError": Value::Null,
            "notice": Value::Null,
            "updatedAt": format!("2026-11-02T22:40:1{index}.000Z"),
        })
        .to_string()
    }

    #[test]
    fn a_projection_answers_from_one_state_tree_walk() {
        let family = family_with_versions("one-walk", 3);
        STATE_TREE_WALKS.with(|walks| walks.set(0));
        let snapshot = family.snapshot();
        let walks = STATE_TREE_WALKS.with(|walks| walks.get());
        assert_eq!(
            walks, 1,
            "the projection walked the state tree {walks} times"
        );
        let issues = snapshot["issues"].as_array().expect("an issue list");
        assert_eq!(
            issues.len(),
            3,
            "every worker version's issues belong to the projection"
        );
        assert_eq!(family.forge_urls().len(), 3);
    }
}

#[cfg(test)]
mod cycle_projections {
    //! A Start's answer frame is the family's projection, so the cycle-history
    //! read behind it decides the action's latency. A run report carries the
    //! whole cycle evidence — tens of megabytes on a populated host — so the
    //! projection reads the bounded summary recorded beside it, once per run.
    //! The pre-change path parsed every retained report on every projection.

    use super::*;

    fn fixture_root(label: &str) -> PathBuf {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!("cycle-projections-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("repo")).expect("a fixture repo");
        std::fs::create_dir_all(root.join("state")).expect("a fixture state");
        root
    }

    fn stamp(index: usize) -> String {
        format!("2026-11-09T10-1{index}-00-000Z")
    }

    fn report_document(index: usize) -> Value {
        json!({
            "cycle": format!("2026-11-09T10:1{index}:00.000Z"),
            "window": {
                "start": format!("2026-11-09T10:0{index}:00.000Z"),
                "end": format!("2026-11-09T10:1{index}:00.000Z"),
            },
            "action": "none",
            "findings": Value::Array(Vec::new()),
            "issues": [{"url": format!("http://forge.invalid/issues/{}", index + 1)}],
            "reason": "no finding in the window",
            // The evidence a cycle writes and a projection never reads.
            "cleanup": {
                "entries": vec![json!({"path": "/fixture/build", "bytes": 1}); 20_000],
            },
        })
    }

    /// One watchdog family whose state tree retains `runs` cycle reports.
    fn family_with_runs(label: &str, runs: usize) -> (WatchdogFamily, PathBuf) {
        let root = fixture_root(label);
        let repo_dir = root.join("repo");
        let state_dir = root.join("state");
        let runs_directory = watchdog_directory(&repo_dir).join("runs");
        for index in 0..runs {
            let directory = runs_directory.join(stamp(index));
            std::fs::create_dir_all(&directory).expect("a run directory");
            std::fs::write(
                directory.join("report.json"),
                report_document(index).to_string(),
            )
            .expect("a run report");
        }
        let spawn: SpawnFn =
            Arc::new(|_argv: &[String], _environment: HashMap<String, String>| None);
        let family = WatchdogFamily::new(
            &repo_dir,
            &state_dir,
            &HashMap::new(),
            None,
            Arc::new(Mutex::new(spawn)),
            Arc::new(Mutex::new(None)),
            None,
            Arc::new(|| 0),
        );
        (family, runs_directory)
    }

    #[test]
    fn a_projection_reads_each_run_report_once() {
        let (family, runs_directory) = family_with_runs("once", 3);

        crate::workers::cycle::REPORT_PARSES.with(|parses| parses.set(0));
        let first = family.snapshot();
        let parsed = crate::workers::cycle::REPORT_PARSES.with(|parses| parses.get());
        assert_eq!(
            parsed, 3,
            "the first projection reads each run report once, not {parsed} times"
        );
        let cycles = first["detail"]["cycles"]
            .as_array()
            .expect("a cycle history");
        assert_eq!(cycles.len(), 3);
        assert_eq!(cycles[0]["at"], json!("2026-11-09T10:12:00.000Z"));
        assert_eq!(cycles[2]["at"], json!("2026-11-09T10:10:00.000Z"));
        assert_eq!(
            cycles[0]["issues"],
            json!(["http://forge.invalid/issues/3"])
        );
        assert_eq!(
            first["cadence"]["lastRunAt"],
            json!("2026-11-09T10:12:00.000Z")
        );
        for index in 0..3 {
            assert!(runs_directory
                .join(stamp(index))
                .join(crate::workers::cycle::SUMMARY_FILE)
                .exists());
        }

        crate::workers::cycle::REPORT_PARSES.with(|parses| parses.set(0));
        let second = family.snapshot();
        let parsed = crate::workers::cycle::REPORT_PARSES.with(|parses| parses.get());
        assert_eq!(
            parsed, 0,
            "a projection re-parsed {parsed} run reports that already record a summary"
        );
        assert_eq!(second["detail"], first["detail"]);
    }
}

#[cfg(test)]
mod cycle_summary_rows {
    //! The summary a run records must answer the identical cycle row its full
    //! report does: a bounded read is only a fix while it is the same read.

    use super::*;

    #[test]
    fn a_summary_answers_the_same_cycle_row_as_its_report() {
        let report = json!({
            "cycle": "2026-11-09T10:10:00.000Z",
            "window": {
                "start": "2026-11-09T10:00:00.000Z",
                "end": "2026-11-09T10:10:00.000Z",
            },
            "action": "filed",
            "findings": [
                {"fingerprint": "a", "line": "the first finding"},
                {"line": "a finding without a fingerprint"},
                {"fingerprint": "a", "line": "the first finding again"},
            ],
            "issues": [
                {"url": "http://forge.invalid/issues/1", "title": "one"},
                {"url": "http://forge.invalid/issues/1"},
                {"title": "an issue row without a url"},
            ],
            "reason": "filed 1 issue(s)",
            "cleanup": {"entries": [{"path": "/fixture/build"}]},
        });
        let resolve = |fingerprint: &str| {
            (fingerprint == "a").then(|| "http://forge.invalid/issues/1".to_string())
        };
        let bounded = crate::workers::cycle::summary(&report).expect("a summary");
        let full_row = cycle_from_report(&report, &resolve).expect("the report's row");
        let bounded_row = cycle_from_report(&bounded, &resolve).expect("the summary's row");
        assert_eq!(bounded_row, full_row);
        assert_eq!(full_row["findings"], json!(3));
        assert_eq!(full_row["issues"], json!(["http://forge.invalid/issues/1"]));
    }
}
