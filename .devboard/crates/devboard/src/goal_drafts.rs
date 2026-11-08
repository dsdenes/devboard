//! Proposed-goal drafts: listing, reading, deleting, and the elaboration runs
//! the draft owner process carries.
//!
//! A draft is unprocessed Markdown under `.devboard/goal-proposals/`. The
//! Drafts view lists them, shows one verbatim, and starts the harness
//! `/goal-draft <path>` turn in one detached owner per draft. The owner holds
//! the ACP peer and persists its run under `STATE_DIR`, so a replacement
//! dashboard attaches to the same owners; this module validates paths, streams
//! each run's state, and spawns the owners.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};

use crate::acp::AcpId;
use crate::app::Conn;

/// Where drafts live, relative to the repository root.
pub const GOAL_PROPOSALS_DIRECTORY: &str = ".devboard/goal-proposals";

/// Envelope version of the owner state file.
pub const GOAL_DRAFT_OWNER_VERSION: u64 = 1;

/// How long a started run may take before its owner publishes its identity.
/// The dashboard never judges a run by the argv of the launcher it forked.
pub const OWNER_CLAIM_GRACE_MS: i64 = 10_000;

/// The recorded error of a run no owner ever claimed.
pub const GOAL_DRAFT_OWNER_DID_NOT_START: &str = "The elaboration owner did not start.";

/// The recorded error of a run whose owner exited and whose one automatic
/// restart also died.
pub const GOAL_DRAFT_OWNER_EXITED: &str = "The elaboration owner exited before it finished.";

/// The poll cadence the dashboard observes owners with.
const POLL_MS: u64 = 150;
/// The owners are told their supervisor is alive at this cadence, not every poll.
const LEASE_INTERVAL_MS: i64 = 400;

/// One draft as the drafts view lists it.
#[derive(Debug, Clone)]
pub struct GoalDraftSummary {
    pub path: String,
    pub name: String,
    pub heading: String,
}

impl GoalDraftSummary {
    pub fn to_json(&self) -> Value {
        json!({"path": self.path, "name": self.name, "heading": self.heading})
    }
}

/// One draft's full bytes.
#[derive(Debug, Clone)]
pub struct GoalDraft {
    pub path: String,
    pub name: String,
    pub heading: String,
    pub text: String,
}

impl GoalDraft {
    pub fn to_json(&self) -> Value {
        json!({
            "path": self.path,
            "name": self.name,
            "heading": self.heading,
            "text": self.text,
        })
    }
}

/// One refusal with the HTTP status the client sees in the message contract.
#[derive(Debug, Clone)]
pub struct GoalDraftError {
    pub status: u16,
    pub message: String,
}

impl GoalDraftError {
    fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

/// The lifecycle state a draft run reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GoalDraftStatus {
    Idle,
    Running,
    Succeeded,
    Failed,
    Stopped,
}

impl GoalDraftStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Stopped => "stopped",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "idle" => Some(Self::Idle),
            "running" => Some(Self::Running),
            "succeeded" => Some(Self::Succeeded),
            "failed" => Some(Self::Failed),
            "stopped" => Some(Self::Stopped),
            _ => None,
        }
    }

    fn from_value(value: &Value) -> Option<Self> {
        Self::parse(value.as_str()?)
    }
}

/// One question the elaboration peer waits on.
#[derive(Debug, Clone, PartialEq)]
pub struct GoalDraftQuestion {
    pub id: AcpId,
    pub message: String,
    pub options: Vec<crate::acp::AcpQuestionOption>,
}

impl GoalDraftQuestion {
    pub fn to_json(&self) -> Value {
        let mut event = Map::new();
        event.insert(
            "id".into(),
            serde_json::to_value(&self.id).unwrap_or(Value::Null),
        );
        event.insert("message".into(), Value::String(self.message.clone()));
        let options: Vec<Value> = self
            .options
            .iter()
            .map(|option| {
                let mut record = Map::new();
                record.insert("label".into(), Value::String(option.label.clone()));
                if let Some(description) = &option.description {
                    record.insert("description".into(), Value::String(description.clone()));
                }
                record.insert("recommended".into(), Value::Bool(option.recommended));
                Value::Object(record)
            })
            .collect();
        event.insert("options".into(), Value::Array(options));
        Value::Object(event)
    }
}

/// One draft's elaboration run, as the state file and frames carry it.
#[derive(Debug, Clone, PartialEq)]
pub struct GoalDraftRun {
    pub status: GoalDraftStatus,
    pub path: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub error: Option<String>,
    pub activity: Vec<String>,
    pub question: Option<GoalDraftQuestion>,
}

impl GoalDraftRun {
    /// The run a path without an owner reports.
    pub fn idle() -> Self {
        Self {
            status: GoalDraftStatus::Idle,
            path: None,
            started_at: None,
            finished_at: None,
            error: None,
            activity: Vec::new(),
            question: None,
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "status": self.status.as_str(),
            "path": self.path,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "error": self.error,
            "activity": self.activity,
            "question": self.question.as_ref().map(GoalDraftQuestion::to_json),
        })
    }
}

/// One ACP child recorded in the state so a replacement can prove and end it.
#[derive(Debug, Clone, PartialEq)]
pub struct RecordedChild {
    pub pid: u32,
    pub argv: Vec<String>,
    pub cwd: String,
}

impl RecordedChild {
    pub fn to_json(&self) -> Value {
        json!({"pid": self.pid, "argv": self.argv, "cwd": self.cwd})
    }

    fn parse(value: Option<&Value>) -> Option<Self> {
        let record = value?.as_object()?;
        let pid = record.get("pid")?.as_i64()?;
        if pid <= 0 || pid > u32::MAX as i64 {
            return None;
        }
        let argv: Vec<String> = record
            .get("argv")?
            .as_array()?
            .iter()
            .map(|entry| entry.as_str().map(str::to_string))
            .collect::<Option<Vec<String>>>()?;
        let cwd = record.get("cwd")?.as_str()?.to_string();
        if cwd.is_empty() {
            return None;
        }
        Some(Self {
            pid: pid as u32,
            argv,
            cwd,
        })
    }
}

/// Everything one detached owner persists for one draft.
#[derive(Debug, Clone, PartialEq)]
pub struct GoalDraftOwnerState {
    pub version: u64,
    pub run: GoalDraftRun,
    pub owner: Option<RecordedChild>,
    pub peer: Option<RecordedChild>,
    pub launcher_pid: Option<u32>,
    pub supervisor_pid: Option<u32>,
    pub updated_at: String,
}

impl GoalDraftOwnerState {
    pub fn to_json(&self) -> Value {
        json!({
            "version": self.version,
            "run": self.run.to_json(),
            "owner": self.owner.as_ref().map(RecordedChild::to_json),
            "peer": self.peer.as_ref().map(RecordedChild::to_json),
            "launcherPid": self.launcher_pid,
            "supervisorPid": self.supervisor_pid,
            "updatedAt": self.updated_at,
        })
    }
}

/// A dashboard-to-owner instruction; commands are consumed in name order.
#[derive(Debug, Clone, PartialEq)]
pub enum GoalDraftOwnerCommand {
    Answer { id: AcpId, value: String },
    Stop,
}

impl GoalDraftOwnerCommand {
    fn to_json(&self) -> Value {
        match self {
            Self::Answer { id, value } => json!({
                "type": "answer",
                "id": serde_json::to_value(id).unwrap_or(Value::Null),
                "value": value,
            }),
            Self::Stop => json!({"type": "stop"}),
        }
    }

    fn parse(text: &str) -> Option<Self> {
        let parsed: Value = serde_json::from_str(text).ok()?;
        let record = parsed.as_object()?;
        match record.get("type")?.as_str()? {
            "stop" => Some(Self::Stop),
            "answer" => Some(Self::Answer {
                id: AcpId::from_value(record.get("id")?)?,
                value: record.get("value")?.as_str()?.to_string(),
            }),
            _ => None,
        }
    }
}

/// The marker a reload writes so its replacement may adopt the owners.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GoalDraftHandoff {
    pub at: i64,
    pub pid: u32,
}

/// The dashboard that currently supervises the owners.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoalDraftLease {
    pub pid: u32,
    pub updated_at: i64,
    pub instance: Option<String>,
}

// ---------------------------------------------------------------------------
// Paths

fn absolute(path: &Path) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
}

/// The absolute form of a path, resolving symlinks where possible.
pub fn canonical_process_path(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// `<STATE_DIR>/goal-drafts/<repository key>`.
pub fn goal_draft_state_directory(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    absolute(state_dir)
        .join("goal-drafts")
        .join(crate::journal::journal_key(&absolute(repo_dir)))
}

/// The directory holding one state directory per running or finished draft.
pub fn goal_draft_runs_directory(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    goal_draft_state_directory(state_dir, repo_dir).join("runs")
}

/// The draft-keyed directory; the path never becomes a filename.
pub fn goal_draft_run_directory(state_dir: &Path, repo_dir: &Path, path: &str) -> PathBuf {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(path.as_bytes());
    let key = hex::encode(digest)[..24].to_string();
    goal_draft_runs_directory(state_dir, repo_dir).join(key)
}

pub fn goal_draft_owner_state_path(state_dir: &Path, repo_dir: &Path, path: &str) -> PathBuf {
    goal_draft_run_directory(state_dir, repo_dir, path).join("state.json")
}

pub fn goal_draft_control_directory(state_dir: &Path, repo_dir: &Path, path: &str) -> PathBuf {
    goal_draft_run_directory(state_dir, repo_dir, path).join("control")
}

pub fn goal_draft_handoff_path(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    goal_draft_state_directory(state_dir, repo_dir).join("handoff.json")
}

pub fn goal_draft_lease_path(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    goal_draft_state_directory(state_dir, repo_dir).join("lease.json")
}

// ---------------------------------------------------------------------------
// Durable JSON

fn read_json(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Replaces one file atomically; a reader never sees a half-written value.
fn write_json(path: &Path, value: &Value) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    let mut text = crate::jsjson::stringify(value);
    text.push('\n');
    let result = (|| {
        std::fs::write(&temporary, text)?;
        std::fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn remove_file(path: &Path) {
    let _ = std::fs::remove_file(path);
}

fn now_iso() -> String {
    crate::journal::now_iso8601()
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn parse_question(value: Option<&Value>) -> Option<Option<GoalDraftQuestion>> {
    let Some(value) = value else {
        return Some(None);
    };
    if value.is_null() {
        return Some(None);
    }
    let record = value.as_object()?;
    let id = AcpId::from_value(record.get("id")?)?;
    let message = record.get("message")?.as_str()?.to_string();
    let options = record.get("options")?.as_array()?;
    let mut parsed = Vec::new();
    for option in options {
        let option = option.as_object()?;
        let label = option.get("label")?.as_str()?.to_string();
        let description = option
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string);
        let recommended = option
            .get("recommended")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        parsed.push(crate::acp::AcpQuestionOption {
            label,
            description,
            recommended,
        });
    }
    Some(Some(GoalDraftQuestion {
        id,
        message,
        options: parsed,
    }))
}

fn parse_run(value: &Value) -> Option<GoalDraftRun> {
    let record = value.as_object()?;
    let status = GoalDraftStatus::from_value(record.get("status")?)?;
    let path = match record.get("path")? {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        _ => return None,
    };
    let timestamp = |key: &str| -> Option<Option<String>> {
        match record.get(key)? {
            Value::Null => Some(None),
            Value::String(text) => Some(Some(text.clone())),
            _ => None,
        }
    };
    let started_at = timestamp("startedAt")?;
    let finished_at = timestamp("finishedAt")?;
    let error = match record.get("error")? {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        _ => return None,
    };
    let activity = record
        .get("activity")?
        .as_array()?
        .iter()
        .map(|line| line.as_str().map(str::to_string))
        .collect::<Option<Vec<String>>>()?;
    let question = parse_question(record.get("question"))?;
    Some(GoalDraftRun {
        status,
        path,
        started_at,
        finished_at,
        error,
        activity,
        question,
    })
}

fn parse_state(value: &Value) -> Option<GoalDraftOwnerState> {
    let record = value.as_object()?;
    if record.get("version")?.as_u64()? != GOAL_DRAFT_OWNER_VERSION {
        return None;
    }
    let run = parse_run(record.get("run")?)?;
    run.path.as_ref()?;
    let pid_field = |key: &str| -> Option<Option<u32>> {
        match record.get(key) {
            None | Some(Value::Null) => Some(None),
            Some(Value::Number(number)) => {
                let pid = number.as_i64()?;
                if !(0..=u32::MAX as i64).contains(&pid) {
                    return None;
                }
                Some(Some(pid as u32))
            }
            Some(_) => None,
        }
    };
    let supervisor_pid = pid_field("supervisorPid")?;
    let launcher_pid = match pid_field("launcherPid")? {
        Some(pid) => Some(pid),
        None => supervisor_pid,
    };
    Some(GoalDraftOwnerState {
        version: GOAL_DRAFT_OWNER_VERSION,
        run,
        owner: RecordedChild::parse(record.get("owner")),
        peer: RecordedChild::parse(record.get("peer")),
        launcher_pid,
        supervisor_pid,
        updated_at: record
            .get("updatedAt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    })
}

/// Reads one draft's owner state; unusable bytes read as absent.
pub fn read_goal_draft_owner_state(
    state_dir: &Path,
    repo_dir: &Path,
    path: &str,
) -> Option<GoalDraftOwnerState> {
    parse_state(&read_json(&goal_draft_owner_state_path(
        state_dir, repo_dir, path,
    ))?)
}

/// Every readable owner state under the repository's runs directory.
pub fn list_goal_draft_owner_states(state_dir: &Path, repo_dir: &Path) -> Vec<GoalDraftOwnerState> {
    let directory = goal_draft_runs_directory(state_dir, repo_dir);
    let Ok(entries) = std::fs::read_dir(&directory) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    let mut states = Vec::new();
    for name in names {
        let Some(parsed) = read_json(&directory.join(&name).join("state.json")) else {
            continue;
        };
        if let Some(state) = parse_state(&parsed) {
            states.push(state);
        }
    }
    states
}

pub fn write_goal_draft_owner_state(
    state_dir: &Path,
    repo_dir: &Path,
    path: &str,
    state: &GoalDraftOwnerState,
) {
    let _ = write_json(
        &goal_draft_owner_state_path(state_dir, repo_dir, path),
        &state.to_json(),
    );
}

/// Forgets one draft's previous run and its queued commands, so a fresh owner
/// never consumes a stop or answer meant for its predecessor.
pub fn reset_goal_draft_run(state_dir: &Path, repo_dir: &Path, path: &str) {
    let _ = std::fs::remove_dir_all(goal_draft_run_directory(state_dir, repo_dir, path));
}

/// The one automatic restart a run has already been given, so a second death
/// is terminal instead of a loop. It lives beside the run's state, never on the
/// wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct GoalDraftAttempt {
    /// When the restarted launcher was forked; the new claim's grace runs from
    /// here, not from the original start.
    at: i64,
    /// Whether an owner had published its identity for this run before it.
    claimed: bool,
}

fn goal_draft_attempt_path(state_dir: &Path, repo_dir: &Path, path: &str) -> PathBuf {
    goal_draft_run_directory(state_dir, repo_dir, path).join("attempt.json")
}

fn read_goal_draft_attempt(
    state_dir: &Path,
    repo_dir: &Path,
    path: &str,
) -> Option<GoalDraftAttempt> {
    let parsed = read_json(&goal_draft_attempt_path(state_dir, repo_dir, path))?;
    let record = parsed.as_object()?;
    if record.get("restarts")?.as_i64()? < 1 {
        return None;
    }
    Some(GoalDraftAttempt {
        at: record.get("at")?.as_i64()?,
        claimed: record.get("claimed")?.as_bool()?,
    })
}

fn write_goal_draft_attempt(
    state_dir: &Path,
    repo_dir: &Path,
    path: &str,
    attempt: GoalDraftAttempt,
) {
    let _ = write_json(
        &goal_draft_attempt_path(state_dir, repo_dir, path),
        &json!({"restarts": 1, "at": attempt.at, "claimed": attempt.claimed}),
    );
}

pub fn read_goal_draft_handoff(state_dir: &Path, repo_dir: &Path) -> Option<GoalDraftHandoff> {
    let parsed = read_json(&goal_draft_handoff_path(state_dir, repo_dir))?;
    let record = parsed.as_object()?;
    let at = record.get("at")?.as_i64()?;
    let pid = record.get("pid")?.as_i64()?;
    if !(0..=u32::MAX as i64).contains(&pid) {
        return None;
    }
    Some(GoalDraftHandoff {
        at,
        pid: pid as u32,
    })
}

pub fn write_goal_draft_handoff(state_dir: &Path, repo_dir: &Path, handoff: GoalDraftHandoff) {
    let _ = write_json(
        &goal_draft_handoff_path(state_dir, repo_dir),
        &json!({"at": handoff.at, "pid": handoff.pid}),
    );
}

pub fn remove_goal_draft_handoff(state_dir: &Path, repo_dir: &Path) {
    remove_file(&goal_draft_handoff_path(state_dir, repo_dir));
}

/// Tells the owners a replacement is coming, so they keep their agents across
/// the reload. Written before the server stops; a replacement adopts them when
/// it takes the lease, and any other exit interrupts them after the grace.
pub fn handoff_goal_draft_runs(state_dir: &Path, repo_dir: &Path) {
    let owned_running = list_goal_draft_owner_states(state_dir, repo_dir)
        .iter()
        .any(|state| state.run.status == GoalDraftStatus::Running && state_owner_alive(state));
    if !owned_running {
        return;
    }
    write_goal_draft_handoff(
        state_dir,
        repo_dir,
        GoalDraftHandoff {
            at: now_millis(),
            pid: std::process::id(),
        },
    );
}

pub fn read_goal_draft_lease(state_dir: &Path, repo_dir: &Path) -> Option<GoalDraftLease> {
    let parsed = read_json(&goal_draft_lease_path(state_dir, repo_dir))?;
    let record = parsed.as_object()?;
    let pid = record.get("pid")?.as_i64()?;
    if !(0..=u32::MAX as i64).contains(&pid) {
        return None;
    }
    let updated_at = record.get("updatedAt")?.as_i64()?;
    Some(GoalDraftLease {
        pid: pid as u32,
        updated_at,
        instance: record
            .get("instance")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
    })
}

pub fn write_goal_draft_lease(state_dir: &Path, repo_dir: &Path, lease: &GoalDraftLease) {
    let mut record = Map::new();
    record.insert("pid".into(), lease.pid.into());
    record.insert("updatedAt".into(), lease.updated_at.into());
    if let Some(instance) = &lease.instance {
        record.insert("instance".into(), Value::String(instance.clone()));
    }
    let _ = write_json(
        &goal_draft_lease_path(state_dir, repo_dir),
        &Value::Object(record),
    );
}

/// Writes one instruction atomically; the owner consumes it in name order.
pub fn write_goal_draft_owner_command(directory: &Path, command: &GoalDraftOwnerCommand) {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let _ = std::fs::create_dir_all(directory);
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1;
    let name = format!("{:014}-{:06}.json", now_millis(), sequence);
    let _ = write_json(&directory.join(name), &command.to_json());
}

/// Reads and consumes every pending instruction in name order.
pub fn take_goal_draft_owner_commands(directory: &Path) -> Vec<GoalDraftOwnerCommand> {
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
        remove_file(&path);
        if let Some(command) = GoalDraftOwnerCommand::parse(&text) {
            commands.push(command);
        }
    }
    commands
}

// ---------------------------------------------------------------------------
// Process identity

/// True only when the pid still runs exactly the recorded command in the
/// recorded cwd.
pub fn recorded_child_alive(child: &RecordedChild) -> bool {
    if !crate::supervision::live_process(child.pid) {
        return false;
    }
    let Some(argv) = crate::supervision::process_argv(child.pid) else {
        return false;
    };
    if argv != child.argv {
        return false;
    }
    let Ok(cwd) = std::fs::read_link(format!("/proc/{}/cwd", child.pid)) else {
        return false;
    };
    cwd == canonical_process_path(Path::new(&child.cwd))
}

fn state_owner_alive(state: &GoalDraftOwnerState) -> bool {
    state.owner.as_ref().is_some_and(recorded_child_alive)
}

/// The child identity of this process, for the state's `owner` field.
pub fn self_child(cwd: &Path) -> RecordedChild {
    let mut argv: Vec<String> = std::fs::read("/proc/self/cmdline")
        .map(|raw| {
            String::from_utf8_lossy(&raw)
                .split('\0')
                .filter(|part| !part.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if argv.is_empty() {
        argv = std::env::args().collect();
    }
    RecordedChild {
        pid: std::process::id(),
        argv,
        cwd: canonical_process_path(cwd).display().to_string(),
    }
}

// ---------------------------------------------------------------------------
// Activity

/// Per-run bound: the first of 1,000 entries or 1 MiB, with a marker.
pub fn append_activity_line(lines: &mut Vec<String>, text: &str, append: bool) {
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
    use crate::state::{ACTIVITY_MAX_BYTES, ACTIVITY_MAX_ENTRIES, ACTIVITY_TRIMMED_MARKER};
    let total: usize = lines.iter().map(String::len).sum();
    if lines.len() <= ACTIVITY_MAX_ENTRIES && total <= ACTIVITY_MAX_BYTES {
        return;
    }
    let mut kept: Vec<String> = Vec::new();
    let mut kept_bytes = ACTIVITY_TRIMMED_MARKER.len();
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
    lines.clear();
    lines.push(ACTIVITY_TRIMMED_MARKER.to_string());
    lines.extend(kept);
}

// ---------------------------------------------------------------------------
// Draft files

/// The first ATX heading line's text, with trailing hashes removed.
pub fn goal_draft_heading(text: &str) -> String {
    for line in text.split('\n') {
        let hashes = line
            .chars()
            .take_while(|character| *character == '#')
            .count();
        if !(1..=6).contains(&hashes) {
            continue;
        }
        let rest = &line[hashes..];
        if !rest.starts_with(' ') {
            continue;
        }
        let mut heading = rest.trim().to_string();
        if heading.ends_with('#') {
            heading = heading.trim_end_matches('#').trim_end().to_string();
        }
        if !heading.is_empty() {
            return heading;
        }
    }
    String::new()
}

/// Resolves one repository-relative draft path.
pub fn resolve_goal_draft(
    repo_dir: &Path,
    relative_path: Option<&Value>,
) -> Result<(String, String, PathBuf), GoalDraftError> {
    let Some(value) = relative_path else {
        return Err(GoalDraftError::new(400, "A draft path is required."));
    };
    let Some(text) = value.as_str() else {
        return Err(GoalDraftError::new(400, "A draft path is required."));
    };
    let normalized = text.replace('\\', "/");
    if normalized.is_empty()
        || normalized.starts_with('/')
        || (normalized.len() > 2
            && normalized.as_bytes()[0].is_ascii_alphabetic()
            && normalized.as_bytes()[1] == b':'
            && normalized.as_bytes()[2] == b'/')
    {
        return Err(GoalDraftError::new(
            400,
            "A draft path must be repository-relative.",
        ));
    }
    let parts: Vec<&str> = normalized.split('/').collect();
    if parts.len() != 3 || parts[0] != ".devboard" || parts[1] != "goal-proposals" {
        return Err(GoalDraftError::new(
            400,
            format!("A draft path must name a file directly under {GOAL_PROPOSALS_DIRECTORY}/."),
        ));
    }
    let name = parts[2].to_string();
    if name.is_empty() || name == "." || name == ".." || !name.ends_with(".md") {
        return Err(GoalDraftError::new(400, "A draft path must end in .md."));
    }
    let directory = repo_dir.join(GOAL_PROPOSALS_DIRECTORY);
    let Ok(real_directory) = directory.canonicalize() else {
        return Err(GoalDraftError::new(
            404,
            format!("No draft at {normalized}."),
        ));
    };
    let candidate = directory.join(&name);
    let Ok(real_file) = candidate.canonicalize() else {
        return Err(GoalDraftError::new(
            404,
            format!("No draft at {normalized}."),
        ));
    };
    if real_file.parent() != Some(real_directory.as_path()) {
        return Err(GoalDraftError::new(
            400,
            format!("A draft path must stay directly under {GOAL_PROPOSALS_DIRECTORY}/."),
        ));
    }
    let metadata = std::fs::metadata(&real_file)
        .map_err(|_| GoalDraftError::new(404, format!("No draft at {normalized}.")))?;
    if !metadata.is_file() {
        return Err(GoalDraftError::new(400, "A draft must be a regular file."));
    }
    Ok((
        format!("{GOAL_PROPOSALS_DIRECTORY}/{name}"),
        name,
        real_file,
    ))
}

/// Every regular `.md` file directly under the drafts directory, by name.
pub fn list_goal_drafts(repo_dir: &Path) -> Vec<GoalDraftSummary> {
    let directory = repo_dir.join(GOAL_PROPOSALS_DIRECTORY);
    let Ok(entries) = std::fs::read_dir(&directory) else {
        return Vec::new();
    };
    let mut drafts = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let is_file = entry
            .file_type()
            .map(|kind| kind.is_file())
            .unwrap_or(false);
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_file || !name.ends_with(".md") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        drafts.push(GoalDraftSummary {
            path: format!("{GOAL_PROPOSALS_DIRECTORY}/{name}"),
            name,
            heading: goal_draft_heading(&text),
        });
    }
    drafts.sort_by(|left, right| left.name.cmp(&right.name));
    drafts
}

/// Reads one draft's bytes exactly, after the same path validation.
pub fn read_goal_draft(repo_dir: &Path, path: Option<&Value>) -> Result<GoalDraft, GoalDraftError> {
    let (relative, name, file) = resolve_goal_draft(repo_dir, path)?;
    let text = std::fs::read_to_string(&file)
        .map_err(|_| GoalDraftError::new(404, format!("No draft at {relative}.")))?;
    Ok(GoalDraft {
        heading: goal_draft_heading(&text),
        path: relative,
        name,
        text,
    })
}

/// Whether an elaboration run is live for this draft.
pub fn is_goal_draft_running(state_dir: &Path, repo_dir: &Path, path: &str) -> bool {
    read_goal_draft_owner_state(state_dir, repo_dir, path).is_some_and(|state| {
        state.run.status == GoalDraftStatus::Running && state_owner_alive(&state)
    })
}

/// Deletes one draft. A draft being elaborated is refused with 409.
pub fn delete_goal_draft(
    repo_dir: &Path,
    path: Option<&Value>,
) -> Result<GoalDraftSummary, GoalDraftError> {
    let draft = read_goal_draft(repo_dir, path)?;
    let (_, _, file) = resolve_goal_draft(repo_dir, path)?;
    let state_dir = crate::supervision::default_supervision_state_directory();
    if is_goal_draft_running(&state_dir, repo_dir, &draft.path) {
        return Err(GoalDraftError::new(
            409,
            "This draft is being elaborated. Stop the elaboration and delete it again.",
        ));
    }
    std::fs::remove_file(&file)
        .map_err(|_| GoalDraftError::new(404, format!("No draft at {}.", draft.path)))?;
    Ok(GoalDraftSummary {
        path: draft.path,
        name: draft.name,
        heading: draft.heading,
    })
}

/// Sends the `issuesDraftError` frame with the optional path field.
pub fn send_draft_error(conn: &Conn, path: Option<&str>, message: &str) {
    let mut event = serde_json::Map::new();
    event.insert("type".into(), "issuesDraftError".into());
    if let Some(path) = path {
        event.insert("path".into(), path.into());
    }
    event.insert("message".into(), message.into());
    conn.send(Value::Object(event));
}

// ---------------------------------------------------------------------------
// The supervisor: one watcher per state directory and repository

/// One run per draft path, observed from the durable owner states.
struct DraftWatcher {
    repo_dir: PathBuf,
    state_dir: PathBuf,
    agent_command: String,
    owner_executable: PathBuf,
    conns: Vec<Conn>,
    runs: HashMap<String, GoalDraftRun>,
    owners: HashMap<String, GoalDraftOwnerState>,
    instance: String,
    begun: bool,
    supervises: bool,
    last_lease_ms: i64,
}

impl DraftWatcher {
    fn new(repo_dir: PathBuf, state_dir: PathBuf) -> Self {
        let agent_command = std::env::var("AGENT_COMMAND")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "omp acp".to_string());
        // The owner is this binary; the override lets a test binary spawn the
        // harness under test, which is what the dashboard runs in production.
        let owner_executable = std::env::var("DEVBOARD_OWNER_EXECUTABLE")
            .ok()
            .map(PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(crate::relaunch::own_program);
        Self {
            repo_dir,
            state_dir,
            agent_command,
            owner_executable,
            conns: Vec::new(),
            runs: HashMap::new(),
            owners: HashMap::new(),
            instance: uuid::Uuid::new_v4().to_string(),
            begun: false,
            supervises: false,
            last_lease_ms: 0,
        }
    }

    fn subscribe(&mut self, conn: &Conn) {
        if self.conns.iter().any(|existing| existing.id() == conn.id()) {
            return;
        }
        self.conns.push(conn.clone());
    }

    fn send_all(&self, event: Value) {
        for conn in &self.conns {
            conn.send(event.clone());
        }
    }

    fn snapshot(&self, path: &str) -> GoalDraftRun {
        self.runs
            .get(path)
            .cloned()
            .unwrap_or_else(GoalDraftRun::idle)
    }

    fn runs_snapshot(&self) -> Vec<GoalDraftRun> {
        let mut runs: Vec<GoalDraftRun> = self
            .runs
            .iter()
            .filter(|(path, run)| {
                run.status == GoalDraftStatus::Running || self.repo_dir.join(path.as_str()).exists()
            })
            .map(|(_, run)| run.clone())
            .collect();
        runs.sort_by(|left, right| {
            let left = left.path.clone().unwrap_or_default();
            let right = right.path.clone().unwrap_or_default();
            left.cmp(&right)
        });
        runs
    }

    fn emit_state(&self, path: &str) {
        self.send_all(json!({
            "type": "issuesDraftState",
            "draft": self.snapshot(path).to_json(),
        }));
    }

    fn publish_drafts(&self) {
        let drafts: Vec<Value> = list_goal_drafts(&self.repo_dir)
            .iter()
            .map(GoalDraftSummary::to_json)
            .collect();
        self.send_all(json!({"type": "issuesDrafts", "drafts": drafts}));
    }

    /// Writes one run's state. The owner identity is never invented here: only
    /// the owner process itself publishes it, in `owner`.
    fn store_state(
        &mut self,
        path: &str,
        run: GoalDraftRun,
        owner: Option<RecordedChild>,
        peer: Option<RecordedChild>,
    ) -> GoalDraftOwnerState {
        let updated_at = now_iso();
        let state = GoalDraftOwnerState {
            version: GOAL_DRAFT_OWNER_VERSION,
            run: run.clone(),
            owner,
            peer,
            launcher_pid: Some(std::process::id()),
            supervisor_pid: Some(std::process::id()),
            updated_at,
        };
        write_goal_draft_owner_state(&self.state_dir, &self.repo_dir, path, &state);
        self.owners.insert(path.to_string(), state.clone());
        self.runs.insert(path.to_string(), run);
        state
    }

    /// Records one run that can no longer continue, keeping its activity. The
    /// latest durable bytes win, so a line the owner wrote as it died survives.
    fn fail_run(&mut self, state: &GoalDraftOwnerState, error: &str) -> bool {
        let Some(path) = state.run.path.clone() else {
            return false;
        };
        let durable = read_goal_draft_owner_state(&self.state_dir, &self.repo_dir, &path);
        if let Some(durable) = &durable {
            // The owner recorded its own outcome while this decision was made.
            if durable.run.status != GoalDraftStatus::Running {
                return false;
            }
        }
        let latest = durable.unwrap_or_else(|| state.clone());
        // An owner that claimed while this decision was being made is alive.
        if state_owner_alive(&latest) {
            return false;
        }
        let updated_at = now_iso();
        let next = GoalDraftOwnerState {
            version: latest.version,
            run: GoalDraftRun {
                status: GoalDraftStatus::Failed,
                path: Some(path.clone()),
                started_at: latest.run.started_at.clone(),
                finished_at: Some(updated_at.clone()),
                error: Some(error.to_string()),
                activity: latest.run.activity.clone(),
                question: None,
            },
            owner: latest.owner.clone(),
            peer: None,
            launcher_pid: latest.launcher_pid,
            supervisor_pid: latest.supervisor_pid,
            updated_at,
        };
        write_goal_draft_owner_state(&self.state_dir, &self.repo_dir, &path, &next);
        self.owners.insert(path.clone(), next.clone());
        self.runs.insert(path.clone(), next.run.clone());
        self.emit_state(&path);
        true
    }

    /// Forks one owner for one draft. The forked argv belongs to the launcher;
    /// the owner's own process publishes the identity liveness is judged by.
    fn spawn_run_owner(&self, path: &str) -> Option<u32> {
        let argv = owner_argv(
            &self.owner_executable,
            &self.repo_dir,
            &self.state_dir,
            path,
        );
        let mut environment: HashMap<String, String> = std::env::vars().collect();
        environment.insert("AGENT_COMMAND".into(), self.agent_command.clone());
        environment.insert("STATE_DIR".into(), self.state_dir.display().to_string());
        environment.insert("REPO_DIR".into(), self.repo_dir.display().to_string());
        let cwd = canonical_process_path(&self.repo_dir);
        spawn_owner(&argv, &cwd, &environment)
    }

    /// Gives a run whose owner is gone its one automatic restart from the
    /// draft, keeping the recorded activity as the prefix of the new run.
    /// Returns true when the run reached a terminal failure instead.
    fn restart_run(&mut self, state: &GoalDraftOwnerState, claimed: bool) -> bool {
        let Some(path) = state.run.path.clone() else {
            return false;
        };
        let durable = read_goal_draft_owner_state(&self.state_dir, &self.repo_dir, &path);
        if let Some(durable) = &durable {
            if durable.run.status != GoalDraftStatus::Running {
                return false;
            }
        }
        let latest = durable.unwrap_or_else(|| state.clone());
        if state_owner_alive(&latest) {
            return false;
        }
        // A missing draft is never restarted; the refusal a start gives is the
        // recorded cause.
        if let Err(error) = read_goal_draft(&self.repo_dir, Some(&Value::String(path.clone()))) {
            return self.fail_run(&latest, &error.message);
        }
        write_goal_draft_attempt(
            &self.state_dir,
            &self.repo_dir,
            &path,
            GoalDraftAttempt {
                at: now_millis(),
                claimed,
            },
        );
        // The dead owner's agent would otherwise keep editing the same draft.
        if let Some(peer) = latest.peer.clone() {
            if recorded_child_alive(&peer) {
                crate::supervision::signal_process_group(peer.pid, libc::SIGTERM);
            }
        }
        self.store_state(&path, latest.run.clone(), None, None);
        self.emit_state(&path);
        match self.spawn_run_owner(&path) {
            Some(_) => false,
            None => {
                let error = if claimed {
                    GOAL_DRAFT_OWNER_EXITED
                } else {
                    GOAL_DRAFT_OWNER_DID_NOT_START
                };
                let stored = self.owners.get(&path).cloned().unwrap_or(latest);
                self.fail_run(&stored, error)
            }
        }
    }

    /// Decides one running run whose owner has not claimed yet or has died.
    /// The first loss gets one automatic restart; the second is terminal.
    fn supervise_run(&mut self, state: &GoalDraftOwnerState) -> bool {
        if state.run.status != GoalDraftStatus::Running || state_owner_alive(state) {
            return false;
        }
        let Some(path) = state.run.path.clone() else {
            return false;
        };
        let attempt = read_goal_draft_attempt(&self.state_dir, &self.repo_dir, &path);
        match attempt {
            Some(attempt) => {
                if state.owner.is_some() {
                    // The restarted owner claimed and then exited.
                    return self.fail_run(state, GOAL_DRAFT_OWNER_EXITED);
                }
                if now_millis() - attempt.at < OWNER_CLAIM_GRACE_MS {
                    return false;
                }
                let error = if attempt.claimed {
                    GOAL_DRAFT_OWNER_EXITED
                } else {
                    GOAL_DRAFT_OWNER_DID_NOT_START
                };
                self.fail_run(state, error)
            }
            None => {
                if state.owner.is_some() {
                    return self.restart_run(state, true);
                }
                let started = state
                    .run
                    .started_at
                    .as_deref()
                    .and_then(crate::agent_sessions::parse_instant_text)
                    .unwrap_or(0);
                if now_millis() - started < OWNER_CLAIM_GRACE_MS {
                    // The launcher was forked a moment ago; an owner may still
                    // publish its identity.
                    return false;
                }
                self.restart_run(state, false)
            }
        }
    }

    fn owner_alive(&self, path: &str) -> bool {
        self.owners.get(path).is_some_and(state_owner_alive)
    }

    fn write_lease(&mut self) {
        let now = now_millis();
        if now - self.last_lease_ms < LEASE_INTERVAL_MS {
            return;
        }
        self.last_lease_ms = now;
        write_goal_draft_lease(
            &self.state_dir,
            &self.repo_dir,
            &GoalDraftLease {
                pid: std::process::id(),
                updated_at: now,
                instance: Some(self.instance.clone()),
            },
        );
    }

    /// True when a live dashboard other than this watcher holds the lease.
    fn lease_held_by_another(&self, lease: &Option<GoalDraftLease>) -> bool {
        let Some(lease) = lease else {
            return false;
        };
        if !crate::supervision::live_process(lease.pid) {
            return false;
        }
        if lease.pid != std::process::id() {
            return true;
        }
        lease
            .instance
            .as_deref()
            .is_some_and(|instance| instance != self.instance)
    }

    /// Takes supervision only while no live dashboard already holds it.
    fn take_lease(&mut self) {
        if self.supervises {
            return;
        }
        let existing = read_goal_draft_lease(&self.state_dir, &self.repo_dir);
        if self.lease_held_by_another(&existing) {
            return;
        }
        let now = now_millis();
        write_goal_draft_lease(
            &self.state_dir,
            &self.repo_dir,
            &GoalDraftLease {
                pid: std::process::id(),
                updated_at: now,
                instance: Some(self.instance.clone()),
            },
        );
        self.last_lease_ms = now;
        self.supervises = true;
    }

    /// Attaches to every durable run before the Drafts page is served. A live
    /// owner is adopted as it stands: no handoff is required, and a dead owner
    /// is left for the supervising poll to restart or fail truthfully.
    fn begin(&mut self) {
        if self.begun {
            return;
        }
        self.begun = true;
        let states = list_goal_draft_owner_states(&self.state_dir, &self.repo_dir);
        let mut live_owner = false;
        for state in &states {
            let Some(path) = state.run.path.clone() else {
                continue;
            };
            self.owners.insert(path.clone(), state.clone());
            self.runs.insert(path.clone(), state.run.clone());
            if state.run.status == GoalDraftStatus::Running && state_owner_alive(state) {
                live_owner = true;
            }
        }
        // A reload hint describes a handoff this dashboard does not need; an
        // adoption never depends on it.
        remove_goal_draft_handoff(&self.state_dir, &self.repo_dir);
        if !live_owner {
            return;
        }
        let lease = read_goal_draft_lease(&self.state_dir, &self.repo_dir);
        if self.lease_held_by_another(&lease) {
            return;
        }
        self.take_lease();
    }

    /// Re-reads every owner's run; publishes only what changed. Only the
    /// dashboard holding the lease decides a lost owner's fate.
    fn refresh(&mut self) {
        self.begin();
        let states = list_goal_draft_owner_states(&self.state_dir, &self.repo_dir);
        let mut seen: HashSet<String> = HashSet::new();
        let mut terminal_transition = false;
        let mut running: Vec<GoalDraftOwnerState> = Vec::new();
        for stored in states {
            let Some(path) = stored.run.path.clone() else {
                continue;
            };
            seen.insert(path.clone());
            self.owners.insert(path.clone(), stored.clone());
            if stored.run.status == GoalDraftStatus::Running {
                running.push(stored.clone());
            }
            let previous = self.runs.get(&path).cloned();
            if previous.as_ref() == Some(&stored.run) {
                continue;
            }
            self.runs.insert(path.clone(), stored.run.clone());
            self.emit_state(&path);
            if previous
                .as_ref()
                .is_some_and(|run| run.status == GoalDraftStatus::Running)
                && stored.run.status != GoalDraftStatus::Running
            {
                terminal_transition = true;
            }
        }
        let stale: Vec<String> = self
            .runs
            .keys()
            .filter(|path| !seen.contains(*path))
            .cloned()
            .collect();
        for path in stale {
            let previous = self.runs.remove(&path);
            self.owners.remove(&path);
            if previous.is_some_and(|run| run.status == GoalDraftStatus::Running) {
                terminal_transition = true;
            }
        }

        if self.supervises {
            let lease = read_goal_draft_lease(&self.state_dir, &self.repo_dir);
            if self.lease_held_by_another(&lease) {
                self.supervises = false;
            }
        } else if !running.is_empty() {
            self.take_lease();
        }
        if self.supervises {
            for state in &running {
                if self.supervise_run(state) {
                    terminal_transition = true;
                }
            }
            if !running.is_empty() {
                self.write_lease();
            }
        }
        if terminal_transition {
            self.publish_drafts();
        }
    }

    fn start(&mut self, relative_path: Option<&Value>) -> StartOutcome {
        self.refresh();
        let draft = match read_goal_draft(&self.repo_dir, relative_path) {
            Ok(draft) => draft,
            Err(error) => {
                return StartOutcome::Refused {
                    message: error.message,
                    stopped: false,
                }
            }
        };
        let path = draft.path;
        // A running run is the supervisor's to restart or fail; a client start
        // never forks a second owner for it.
        if self
            .runs
            .get(&path)
            .is_some_and(|run| run.status == GoalDraftStatus::Running)
        {
            return StartOutcome::Refused {
                message: "This draft is being elaborated.".to_string(),
                stopped: false,
            };
        }

        let run = GoalDraftRun {
            status: GoalDraftStatus::Running,
            path: Some(path.clone()),
            started_at: Some(now_iso()),
            finished_at: None,
            error: None,
            activity: Vec::new(),
            question: None,
        };
        reset_goal_draft_run(&self.state_dir, &self.repo_dir, &path);
        self.store_state(&path, run.clone(), None, None);
        self.take_lease();

        let Some(_) = self.spawn_run_owner(&path) else {
            let failed = GoalDraftRun {
                status: GoalDraftStatus::Failed,
                finished_at: Some(now_iso()),
                error: Some("the elaboration peer could not be started".to_string()),
                ..run
            };
            self.store_state(&path, failed, None, None);
            self.emit_state(&path);
            self.publish_drafts();
            return StartOutcome::Refused {
                message: "the elaboration peer could not be started".to_string(),
                stopped: false,
            };
        };
        self.emit_state(&path);
        self.publish_drafts();
        StartOutcome::Started
    }

    fn stop(&mut self, path: &str) -> bool {
        self.refresh();
        let run = self.runs.get(path).cloned();
        let Some(run) = run else {
            return false;
        };
        if run.status != GoalDraftStatus::Running {
            return false;
        }
        // A queued Stop is consumed by whichever owner claims the run; a run
        // whose owner is gone is restarted by the supervisor and stops then.
        write_goal_draft_owner_command(
            &goal_draft_control_directory(&self.state_dir, &self.repo_dir, path),
            &GoalDraftOwnerCommand::Stop,
        );
        true
    }

    fn answer(&mut self, path: &str, id: &Value, value: &str) -> bool {
        self.refresh();
        let Some(run) = self.runs.get(path) else {
            return false;
        };
        if run.status != GoalDraftStatus::Running {
            return false;
        }
        let Some(question) = run.question.as_ref() else {
            return false;
        };
        let Some(id) = AcpId::from_value(id) else {
            return false;
        };
        if question.id.as_key() != id.as_key() {
            return false;
        }
        if !self.owner_alive(path) {
            return false;
        }
        write_goal_draft_owner_command(
            &goal_draft_control_directory(&self.state_dir, &self.repo_dir, path),
            &GoalDraftOwnerCommand::Answer {
                id,
                value: value.to_string(),
            },
        );
        true
    }

    /// Removes one draft and its recorded run. The list is republished only
    /// after the file and its run state are gone.
    fn delete(
        &mut self,
        relative_path: Option<&Value>,
    ) -> Result<GoalDraftSummary, GoalDraftError> {
        self.refresh();
        let (resolved, _, file) = resolve_goal_draft(&self.repo_dir, relative_path)?;
        let draft = read_goal_draft(&self.repo_dir, Some(&Value::String(resolved)))?;
        let running = self
            .runs
            .get(&draft.path)
            .is_some_and(|run| run.status == GoalDraftStatus::Running);
        if running || self.owner_alive(&draft.path) {
            return Err(GoalDraftError::new(
                409,
                "This draft is being elaborated. Stop the elaboration and delete it again.",
            ));
        }
        if std::fs::remove_file(&file).is_err() {
            return Err(GoalDraftError::new(
                404,
                format!("No draft at {}.", draft.path),
            ));
        }
        reset_goal_draft_run(&self.state_dir, &self.repo_dir, &draft.path);
        self.runs.remove(&draft.path);
        self.owners.remove(&draft.path);
        self.publish_drafts();
        Ok(GoalDraftSummary {
            path: draft.path,
            name: draft.name,
            heading: draft.heading,
        })
    }
}

enum StartOutcome {
    Started,
    Refused { message: String, stopped: bool },
}

fn owner_argv(executable: &Path, repo_dir: &Path, state_dir: &Path, path: &str) -> Vec<String> {
    vec![
        executable.display().to_string(),
        "worker".into(),
        "goal-draft".into(),
        "--repo".into(),
        repo_dir.display().to_string(),
        "--state-dir".into(),
        state_dir.display().to_string(),
        "--path".into(),
        path.to_string(),
    ]
}

/// Starts one detached owner in its own session with ignored stdio.
fn spawn_owner(argv: &[String], cwd: &Path, environment: &HashMap<String, String>) -> Option<u32> {
    use std::process::{Command, Stdio};
    let argv = crate::resources::wrap_argv(argv.to_vec());
    let program = argv.first()?;
    let mut command = Command::new(program);
    command
        .args(&argv[1..])
        .current_dir(cwd)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for (key, value) in environment {
        command.env(key, value);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        // A new session keeps the owner alive across a dashboard reload.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    let mut child = command.spawn().ok()?;
    let pid = child.id();
    // Reap the child without holding the dashboard's lock.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Some(pid)
}

static WATCHERS: Mutex<Vec<Arc<Mutex<DraftWatcher>>>> = Mutex::new(Vec::new());

fn watch_lock(watcher: &Mutex<DraftWatcher>) -> std::sync::MutexGuard<'_, DraftWatcher> {
    watcher.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// The watcher for one repository under this process's state directory.
fn watcher_for(repo_dir: &Path, state_dir: &Path) -> Arc<Mutex<DraftWatcher>> {
    let repo_dir = absolute(repo_dir);
    let state_dir = absolute(state_dir);
    let mut watchers = WATCHERS.lock().unwrap_or_else(|poison| poison.into_inner());
    if let Some(existing) = watchers.iter().find(|watcher| {
        let guard = watch_lock(watcher);
        guard.repo_dir == repo_dir && guard.state_dir == state_dir
    }) {
        return Arc::clone(existing);
    }
    let watcher = Arc::new(Mutex::new(DraftWatcher::new(repo_dir, state_dir)));
    {
        let mut guard = watch_lock(&watcher);
        guard.begin();
    }
    watchers.push(Arc::clone(&watcher));
    let polling = Arc::clone(&watcher);
    std::thread::Builder::new()
        .name("goal-draft-watch".into())
        .spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
            let mut guard = watch_lock(&polling);
            guard.refresh();
            drop(guard);
        })
        .ok();
    watcher
}

// ---------------------------------------------------------------------------
// Command dispatch

/// Applies one draft command. Returns `false` when the command belongs to
/// another handler.
pub fn handle(conn: &Conn, repo_dir: &Path, command: &crate::command::Command) -> bool {
    use crate::command::Command;
    let handles = matches!(
        command,
        Command::GetGoalDrafts
            | Command::GetGoalDraft { .. }
            | Command::StartGoalDraft { .. }
            | Command::StopGoalDraft { .. }
            | Command::DeleteGoalDraft { .. }
            | Command::AnswerGoalDraft { .. }
    );
    if !handles {
        return false;
    }
    let state_dir = crate::supervision::default_supervision_state_directory();
    let watcher = watcher_for(repo_dir, &state_dir);
    let mut watcher = watch_lock(&watcher);
    watcher.subscribe(conn);

    match command {
        Command::GetGoalDrafts => {
            watcher.refresh();
            let drafts: Vec<Value> = list_goal_drafts(&watcher.repo_dir)
                .iter()
                .map(GoalDraftSummary::to_json)
                .collect();
            let runs: Vec<Value> = watcher
                .runs_snapshot()
                .iter()
                .map(GoalDraftRun::to_json)
                .collect();
            conn.send(json!({"type": "issuesDrafts", "drafts": drafts, "runs": runs}));
        }
        Command::GetGoalDraft { path } => match read_goal_draft(&watcher.repo_dir, path.as_ref()) {
            Ok(draft) => conn.send(json!({"type": "issuesDraftDetail", "draft": draft.to_json()})),
            Err(error) => {
                send_draft_error(conn, path.as_ref().and_then(Value::as_str), &error.message)
            }
        },
        Command::StartGoalDraft { path } => match watcher.start(path.as_ref()) {
            StartOutcome::Started => {}
            StartOutcome::Refused { message, stopped } => {
                if !stopped {
                    send_draft_error(conn, path.as_ref().and_then(Value::as_str), &message);
                }
            }
        },
        Command::StopGoalDraft { path } => {
            let Some(path) = path.as_ref().and_then(Value::as_str) else {
                send_draft_error(conn, None, "Stopping an elaboration needs its draft path.");
                return true;
            };
            if !watcher.stop(path) {
                send_draft_error(conn, Some(path), "That draft is not being elaborated.");
            }
        }
        Command::DeleteGoalDraft { path } => {
            let Some(path) = path.as_ref().and_then(Value::as_str) else {
                conn.send(json!({"type": "error", "message": "Deleting a draft needs its path."}));
                return true;
            };
            if let Err(error) = watcher.delete(Some(&Value::String(path.to_string()))) {
                conn.send(json!({"type": "error", "message": error.message}));
            }
        }
        Command::AnswerGoalDraft { path, id, value } => {
            let path_text = path.as_ref().and_then(Value::as_str);
            let id_value = id.as_ref();
            let valid_id = matches!(id_value, Some(Value::String(_)) | Some(Value::Number(_)));
            let value_text = value.as_ref().and_then(Value::as_str);
            let (Some(path_text), Some(id_value), Some(value_text)) =
                (path_text, id_value.filter(|_| valid_id), value_text)
            else {
                send_draft_error(
                    conn,
                    path_text,
                    "An answer needs its draft path, question id, and value.",
                );
                return true;
            };
            if !watcher.answer(path_text, id_value, value_text) {
                send_draft_error(
                    conn,
                    Some(path_text),
                    "That question is no longer waiting for an answer.",
                );
            }
        }
        _ => return false,
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.test-tmp")
            .join(format!("drafts-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(GOAL_PROPOSALS_DIRECTORY)).expect("a drafts dir");
        root
    }

    #[test]
    fn drafts_list_by_name_and_carry_their_heading() {
        let root = scratch("list");
        std::fs::write(
            root.join(GOAL_PROPOSALS_DIRECTORY).join("b.md"),
            "# Second\n\nbody\n",
        )
        .expect("a draft");
        std::fs::write(
            root.join(GOAL_PROPOSALS_DIRECTORY).join("a.md"),
            "text\n## First ##\n",
        )
        .expect("a draft");
        let drafts = list_goal_drafts(&root);
        assert_eq!(drafts.len(), 2);
        assert_eq!(drafts[0].name, "a.md");
        assert_eq!(drafts[0].heading, "First");
        assert_eq!(drafts[1].heading, "Second");
    }

    #[test]
    fn a_path_outside_the_drafts_directory_is_refused() {
        let root = scratch("paths");
        let error = resolve_goal_draft(&root, Some(&json!("/etc/passwd"))).expect_err("refused");
        assert_eq!(error.status, 400);
        let error = resolve_goal_draft(&root, Some(&json!("other/x.md"))).expect_err("refused");
        assert_eq!(
            error.message,
            "A draft path must name a file directly under .devboard/goal-proposals/."
        );
    }

    #[test]
    fn the_owner_state_keeps_the_typescript_key_order_and_shapes() {
        let run = GoalDraftRun {
            status: GoalDraftStatus::Running,
            path: Some(".devboard/goal-proposals/a.md".to_string()),
            started_at: Some("2026-11-03T00:00:00.000Z".to_string()),
            finished_at: None,
            error: None,
            activity: vec!["Reading the draft".to_string()],
            question: Some(GoalDraftQuestion {
                id: AcpId::Number(7),
                message: "Choose".to_string(),
                options: vec![crate::acp::AcpQuestionOption {
                    label: "Alpha".to_string(),
                    description: Some("The first outcome.".to_string()),
                    recommended: true,
                }],
            }),
        };
        let state = GoalDraftOwnerState {
            version: GOAL_DRAFT_OWNER_VERSION,
            run,
            owner: Some(RecordedChild {
                pid: 42,
                argv: vec!["devboard".to_string(), "worker".to_string()],
                cwd: "/repo".to_string(),
            }),
            peer: None,
            launcher_pid: Some(42),
            supervisor_pid: Some(42),
            updated_at: "2026-11-03T00:00:01.000Z".to_string(),
        };
        let value = state.to_json();
        let keys: Vec<&String> = value.as_object().expect("an object").keys().collect();
        assert_eq!(
            keys,
            vec![
                "version",
                "run",
                "owner",
                "peer",
                "launcherPid",
                "supervisorPid",
                "updatedAt"
            ]
        );
        assert_eq!(value["peer"], Value::Null);
        let run_keys: Vec<&String> = value["run"].as_object().expect("a run").keys().collect();
        assert_eq!(
            run_keys,
            vec![
                "status",
                "path",
                "startedAt",
                "finishedAt",
                "error",
                "activity",
                "question"
            ]
        );
        let text = crate::jsjson::stringify(&value);
        let parsed: Value = serde_json::from_str(&text).expect("valid JSON");
        assert_eq!(parse_state(&parsed), Some(state));
    }

    #[test]
    fn a_state_without_a_run_path_is_unusable() {
        let value = json!({
            "version": GOAL_DRAFT_OWNER_VERSION,
            "run": {
                "status": "running",
                "path": null,
                "startedAt": null,
                "finishedAt": null,
                "error": null,
                "activity": [],
                "question": null,
            },
            "owner": null,
            "peer": null,
            "launcherPid": null,
            "supervisorPid": null,
            "updatedAt": "",
        });
        assert!(parse_state(&value).is_none());
    }

    #[test]
    fn commands_round_trip_in_name_order() {
        let root = scratch("commands");
        let directory = root.join("control");
        write_goal_draft_owner_command(
            &directory,
            &GoalDraftOwnerCommand::Answer {
                id: AcpId::Number(1),
                value: "yes".to_string(),
            },
        );
        write_goal_draft_owner_command(&directory, &GoalDraftOwnerCommand::Stop);
        let commands = take_goal_draft_owner_commands(&directory);
        assert_eq!(commands.len(), 2);
        assert!(matches!(commands[0], GoalDraftOwnerCommand::Answer { .. }));
        assert_eq!(commands[1], GoalDraftOwnerCommand::Stop);
        assert!(take_goal_draft_owner_commands(&directory).is_empty());
    }
}
