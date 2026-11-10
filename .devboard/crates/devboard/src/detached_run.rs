//! The detached owner of one ACP run, and the dashboard's handle to it.
//!
//! A dashboard never holds a Discover, Ask, or Flow agent itself. Every run
//! starts a small owner process in its own session; the owner spawns the ACP
//! peer, appends its activity and assistant text to run-keyed journals, and
//! publishes its question and status in `state.json`. Because the owner is
//! detached, a replacement dashboard attaches to the same run and the same
//! peer, whichever harness version started it.
//!
//! The durable layout matches the TypeScript reference:
//!
//! ```text
//! <STATE_DIR>/runs/<repository key>/<kind>-<digest>/
//!   state.json activity.jsonl text.jsonl prompt.txt control/ closed
//! <STATE_DIR>/runs/<repository key>/lease.json handoff.json
//! ```

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::acp::{AcpActivity, AcpId, AcpQuestion};
use crate::journal::repo_key;

/// Envelope version of the owner state file.
pub const DETACHED_RUN_VERSION: u64 = 1;
/// How long an owner waits for the replacement dashboard a handoff promised.
pub const DETACHED_HANDOFF_GRACE_MS: i64 = 30_000;
/// The recorded error of a run an ordinary server exit ended.
pub const DETACHED_RUN_INTERRUPTED: &str =
    "The server exit interrupted the run, so it was not resumed. Start it again.";
/// Fixed size of the padded lease document.
const LEASE_PADDING: usize = 512;
/// Bound on each run journal: both the activity and the text journal.
const JOURNAL_MAX_ENTRIES: usize = 1_000;
const JOURNAL_MAX_BYTES: u64 = 1024 * 1024;
/// Bytes a header probe reads; a `{"dropped":<n>}` line is far shorter.
const HEADER_PROBE_BYTES: u64 = 128;

/// The lifecycle status a run reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DetachedRunStatus {
    Starting,
    Running,
    Succeeded,
    Failed,
    Stopped,
}

impl DetachedRunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Stopped => "stopped",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "starting" => Some(Self::Starting),
            "running" => Some(Self::Running),
            "succeeded" => Some(Self::Succeeded),
            "failed" => Some(Self::Failed),
            "stopped" => Some(Self::Stopped),
            _ => None,
        }
    }

    pub fn terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Stopped)
    }

    fn json(self) -> Value {
        Value::String(self.as_str().to_string())
    }
}

/// A conversation turn's status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DetachedTurnStatus {
    Idle,
    Running,
    Succeeded,
    Failed,
}

impl DetachedTurnStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "idle" => Some(Self::Idle),
            "running" => Some(Self::Running),
            "succeeded" => Some(Self::Succeeded),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }

    fn json(self) -> Value {
        Value::String(self.as_str().to_string())
    }
}

/// One ACP child recorded in the state so a replacement can prove and end it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedChild {
    pub pid: u32,
    pub argv: Vec<String>,
    pub cwd: String,
}

impl RecordedChild {
    pub fn to_json(&self) -> Value {
        json!({"pid": self.pid, "argv": self.argv, "cwd": self.cwd})
    }

    pub fn parse(value: Option<&Value>) -> Option<Self> {
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
        Some(Self {
            pid: pid as u32,
            argv,
            cwd,
        })
    }
}

/// Everything one detached owner persists about one run.
#[derive(Debug, Clone, PartialEq)]
pub struct DetachedRunState {
    pub version: u64,
    pub kind: String,
    pub key: String,
    pub repo: String,
    pub state_dir: String,
    pub harness_version: Option<String>,
    /// The dashboard instance that started or adopted this run.
    pub instance: String,
    /// The process that started the owner; it supervises when no lease exists.
    pub launcher_pid: Option<u32>,
    /// Identity of this run; a reset supersedes a previous owner's writes.
    pub generation: String,
    /// True for a conversation owner that accepts further prompts.
    pub multi: bool,
    pub turn_seq: Option<u64>,
    pub turn_status: Option<DetachedTurnStatus>,
    pub turn_error: Option<String>,
    pub status: DetachedRunStatus,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub error: Option<String>,
    pub question: Option<AcpQuestion>,
    pub owner: Option<RecordedChild>,
    pub peer: Option<RecordedChild>,
    pub updated_at: String,
}

impl DetachedRunState {
    /// The persisted shape, in the TypeScript key order.
    pub fn to_json(&self) -> Value {
        let mut record = Map::new();
        record.insert("version".into(), self.version.into());
        record.insert("kind".into(), Value::String(self.kind.clone()));
        record.insert("key".into(), Value::String(self.key.clone()));
        record.insert("repo".into(), Value::String(self.repo.clone()));
        record.insert("stateDir".into(), Value::String(self.state_dir.clone()));
        record.insert(
            "harnessVersion".into(),
            self.harness_version
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
        record.insert("instance".into(), Value::String(self.instance.clone()));
        if let Some(pid) = self.launcher_pid {
            record.insert("launcherPid".into(), pid.into());
        }
        record.insert("generation".into(), Value::String(self.generation.clone()));
        if self.multi {
            record.insert("multi".into(), Value::Bool(true));
        }
        if let Some(seq) = self.turn_seq {
            record.insert("turnSeq".into(), seq.into());
        }
        if let Some(status) = self.turn_status {
            record.insert("turnStatus".into(), status.json());
        }
        if let Some(error) = &self.turn_error {
            record.insert("turnError".into(), Value::String(error.clone()));
        }
        record.insert("status".into(), self.status.json());
        record.insert("startedAt".into(), Value::String(self.started_at.clone()));
        record.insert(
            "finishedAt".into(),
            self.finished_at
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
        record.insert(
            "error".into(),
            self.error.clone().map(Value::String).unwrap_or(Value::Null),
        );
        record.insert(
            "question".into(),
            self.question
                .as_ref()
                .and_then(|question| serde_json::to_value(question).ok())
                .unwrap_or(Value::Null),
        );
        record.insert(
            "owner".into(),
            self.owner
                .as_ref()
                .map(RecordedChild::to_json)
                .unwrap_or(Value::Null),
        );
        record.insert(
            "peer".into(),
            self.peer
                .as_ref()
                .map(RecordedChild::to_json)
                .unwrap_or(Value::Null),
        );
        record.insert("updatedAt".into(), Value::String(self.updated_at.clone()));
        Value::Object(record)
    }

    pub fn parse(value: &Value) -> Option<Self> {
        let record = value.as_object()?;
        if record.get("version")?.as_u64()? != DETACHED_RUN_VERSION {
            return None;
        }
        let text = |key: &str| record.get(key).and_then(Value::as_str);
        let nullable = |key: &str| -> Option<Option<String>> {
            match record.get(key)? {
                Value::Null => Some(None),
                Value::String(text) => Some(Some(text.clone())),
                _ => None,
            }
        };
        let kind = text("kind")?.to_string();
        let key = text("key")?.to_string();
        let repo = text("repo")?.to_string();
        let state_dir = text("stateDir")?.to_string();
        let harness_version = nullable("harnessVersion")?;
        let instance = text("instance")?;
        if instance.is_empty() {
            return None;
        }
        let generation = text("generation")?;
        if generation.is_empty() {
            return None;
        }
        let launcher_pid = match record.get("launcherPid") {
            None | Some(Value::Null) => None,
            Some(value) => {
                let pid = value.as_i64()?;
                if !(1..=u32::MAX as i64).contains(&pid) {
                    return None;
                }
                Some(pid as u32)
            }
        };
        let turn_seq = match record.get("turnSeq") {
            None | Some(Value::Null) => None,
            Some(value) => Some(value.as_u64()?),
        };
        let turn_status = match record.get("turnStatus") {
            None | Some(Value::Null) => None,
            Some(value) => Some(DetachedTurnStatus::parse(value.as_str()?)?),
        };
        let turn_error = match record.get("turnError") {
            None | Some(Value::Null) => None,
            Some(Value::String(text)) => Some(text.clone()),
            Some(_) => return None,
        };
        let status = DetachedRunStatus::parse(text("status")?)?;
        let started_at = text("startedAt")?.to_string();
        let finished_at = nullable("finishedAt")?;
        let error = nullable("error")?;
        let question = match record.get("question") {
            None | Some(Value::Null) => None,
            Some(value) => Some(serde_json::from_value::<AcpQuestion>(value.clone()).ok()?),
        };
        Some(Self {
            version: DETACHED_RUN_VERSION,
            kind,
            key,
            repo,
            state_dir,
            harness_version,
            instance: instance.to_string(),
            launcher_pid,
            generation: generation.to_string(),
            multi: record.get("multi") == Some(&Value::Bool(true)),
            turn_seq,
            turn_status,
            turn_error,
            status,
            started_at,
            finished_at,
            error,
            question,
            owner: RecordedChild::parse(record.get("owner")),
            peer: RecordedChild::parse(record.get("peer")),
            updated_at: text("updatedAt").unwrap_or("").to_string(),
        })
    }
}

/// One activity journal entry.
#[derive(Debug, Clone, PartialEq)]
pub struct DetachedRunActivity {
    pub text: String,
    pub append: bool,
}

impl DetachedRunActivity {
    pub fn to_json(&self) -> Value {
        json!({"text": self.text, "append": self.append})
    }
}

/// One journal's consumed byte offset, so a poll reads only appended bytes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DetachedRunJournalCursor {
    pub offset: u64,
    /// The drop count in the header of the generation this offset belongs to.
    pub dropped: u64,
}

/// What one journal read returned, and whether it began at byte 0.
#[derive(Debug, Clone, PartialEq)]
pub struct DetachedRunJournalRead<T> {
    pub entries: Vec<T>,
    /// True when the read began at byte 0: the cursor is new, or the journal
    /// was rewritten by its bound.
    pub from_start: bool,
    /// Entries the bound discarded before this read's first entry.
    pub dropped: u64,
}

// ---------------------------------------------------------------------------
// Paths

/// The absolute form of one path, without resolving symlinks.
pub fn absolute(path: &Path) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
}

/// `<STATE_DIR>/runs/<repository key>`.
pub fn detached_runs_root(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    absolute(state_dir).join("runs").join(repo_key(repo_dir))
}

/// One run's directory; a kind and key never become a path segment directly.
pub fn detached_run_directory(state_dir: &Path, repo_dir: &Path, kind: &str, key: &str) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(kind.as_bytes());
    hasher.update([0u8]);
    hasher.update(key.as_bytes());
    let digest = hex::encode(hasher.finalize());
    let sanitized: String = kind
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' {
                character
            } else {
                '-'
            }
        })
        .collect();
    detached_runs_root(state_dir, repo_dir).join(format!("{sanitized}-{}", &digest[..32]))
}

pub fn detached_run_state_path(directory: &Path) -> PathBuf {
    directory.join("state.json")
}

pub fn detached_run_activity_path(directory: &Path) -> PathBuf {
    directory.join("activity.jsonl")
}

pub fn detached_run_text_path(directory: &Path) -> PathBuf {
    directory.join("text.jsonl")
}

pub fn detached_run_control_directory(directory: &Path) -> PathBuf {
    directory.join("control")
}

/// Marks a run the dashboard explicitly stopped; a new start supersedes it.
pub fn detached_run_closed_path(directory: &Path) -> PathBuf {
    directory.join("closed")
}

pub fn detached_run_prompt_path(directory: &Path) -> PathBuf {
    directory.join("prompt.txt")
}

/// The lease that tells a detached run whether its owner is still alive.
pub fn detached_run_lease_path(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    detached_runs_root(state_dir, repo_dir).join("lease.json")
}

/// The handoff record a replacement leaves for the runs it inherited.
pub fn detached_run_handoff_path(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    detached_runs_root(state_dir, repo_dir).join("handoff.json")
}

// ---------------------------------------------------------------------------
// Durable JSON

/// Reads JSON, treating unreadable bytes as absent.
pub fn read_json(path: &Path) -> Option<Value> {
    // Every detached-run reader samples through the shared cache: a file is
    // read once per change, not once per viewer.
    crate::sampling::json(path).map(|value| (*value).clone())
}

/// Writes one JSON document atomically with a trailing newline.
pub fn write_json(path: &Path, value: &Value) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = PathBuf::from(format!(
        "{}.{}.{}.tmp",
        path.display(),
        std::process::id(),
        rand::random::<u32>()
    ));
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

pub fn read_detached_run_state(directory: &Path) -> Option<DetachedRunState> {
    DetachedRunState::parse(&read_json(&detached_run_state_path(directory))?)
}

pub fn write_detached_run_state(directory: &Path, state: &DetachedRunState) -> std::io::Result<()> {
    write_json(&detached_run_state_path(directory), &state.to_json())
}

/// Removes a finished run so a fresh start never reads its predecessor.
pub fn reset_detached_run(directory: &Path) {
    let _ = std::fs::remove_dir_all(directory);
}

/// How long a closed run's directory waits for its owner to exit.
const CLOSED_RUN_EXIT_WAIT_MS: u64 = 30_000;
/// How often that wait samples the owner.
const CLOSED_RUN_EXIT_POLL_MS: u64 = 25;

/// Removes a closed run's directory once the owner that writes it has exited,
/// so stopping a run drops its record and its journals with it. The owner
/// publishes its final state while it stops, so a directory removed earlier
/// would be re-created without the journal it held; `owner` is the process
/// this dashboard spawned, used while the owner has not recorded itself yet.
pub async fn reap_closed_run(directory: &Path, owner: Option<u32>) {
    let Some(state) = read_detached_run_state(directory) else {
        return;
    };
    let generation = state.generation;
    let Some(owner) = state.owner.map(|record| record.pid).or(owner) else {
        return;
    };
    let deadline = Instant::now() + Duration::from_millis(CLOSED_RUN_EXIT_WAIT_MS);
    while crate::supervision::live_process(owner) {
        if Instant::now() >= deadline {
            return;
        }
        tokio::time::sleep(Duration::from_millis(CLOSED_RUN_EXIT_POLL_MS)).await;
    }
    // A start that reset the directory while this owner exited owns it now.
    if let Some(current) = read_detached_run_state(directory) {
        if current.generation != generation {
            return;
        }
    }
    reset_detached_run(directory);
}

// ---------------------------------------------------------------------------
// Journals

fn parse_dropped_header(line: Option<&str>) -> u64 {
    let Some(line) = line else {
        return 0;
    };
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return 0;
    };
    value
        .as_object()
        .and_then(|record| record.get("dropped"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

fn parse_text_line(line: &str) -> Option<String> {
    if line.is_empty() {
        return None;
    }
    serde_json::from_str::<Value>(line)
        .ok()?
        .as_str()
        .map(str::to_string)
}

fn parse_activity_line(line: &str) -> Option<DetachedRunActivity> {
    if line.is_empty() {
        return None;
    }
    let value: Value = serde_json::from_str(line).ok()?;
    let record = value.as_object()?;
    Some(DetachedRunActivity {
        text: record.get("text")?.as_str()?.to_string(),
        append: record.get("append") == Some(&Value::Bool(true)),
    })
}

/// The lines past `cursor`, holding back a trailing partial line.
fn read_journal_append(
    path: &Path,
    cursor: &mut DetachedRunJournalCursor,
) -> (Vec<String>, bool, u64) {
    let Ok(mut file) = std::fs::File::open(path) else {
        return (Vec::new(), false, cursor.dropped);
    };
    let Ok(size) = file.metadata().map(|metadata| metadata.len()) else {
        return (Vec::new(), false, cursor.dropped);
    };
    let mut probe = [0u8; HEADER_PROBE_BYTES as usize];
    let probed = file.read(&mut probe).unwrap_or(0);
    let header = String::from_utf8_lossy(&probe[..probed]);
    let dropped = parse_dropped_header(header.split('\n').next());
    let rewritten = dropped != cursor.dropped || size < cursor.offset;
    if rewritten {
        cursor.offset = 0;
        cursor.dropped = dropped;
    }
    let from_start = rewritten || cursor.offset == 0;
    if size == cursor.offset {
        return (Vec::new(), from_start, dropped);
    }
    if file.seek(SeekFrom::Start(cursor.offset)).is_err() {
        return (Vec::new(), from_start, dropped);
    }
    let mut buffer = Vec::new();
    if file.read_to_end(&mut buffer).is_err() {
        return (Vec::new(), from_start, dropped);
    }
    let Some(end) = buffer.iter().rposition(|byte| *byte == b'\n') else {
        return (Vec::new(), from_start, dropped);
    };
    cursor.offset += (end + 1) as u64;
    let text = String::from_utf8_lossy(&buffer[..end]).into_owned();
    let lines = if text.is_empty() {
        Vec::new()
    } else {
        text.split('\n').map(str::to_string).collect()
    };
    (lines, from_start, dropped)
}

fn read_text_journal(path: &Path) -> (Vec<String>, u64) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return (Vec::new(), 0);
    };
    let mut entries = Vec::new();
    let mut dropped = 0;
    for (index, line) in text.split('\n').enumerate() {
        if index == 0 {
            dropped = parse_dropped_header(Some(line));
            if dropped > 0 {
                continue;
            }
        }
        if let Some(chunk) = parse_text_line(line) {
            entries.push(chunk);
        }
    }
    (entries, dropped)
}

fn read_activity_journal(path: &Path) -> (Vec<DetachedRunActivity>, u64) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return (Vec::new(), 0);
    };
    let mut entries = Vec::new();
    let mut dropped = 0;
    for (index, line) in text.split('\n').enumerate() {
        if index == 0 {
            dropped = parse_dropped_header(Some(line));
            if dropped > 0 {
                continue;
            }
        }
        if let Some(entry) = parse_activity_line(line) {
            entries.push(entry);
        }
    }
    (entries, dropped)
}

/// Every chunk the text journal holds.
pub fn read_detached_run_text(directory: &Path) -> Vec<String> {
    read_text_journal(&detached_run_text_path(directory)).0
}

/// The chunks appended past `cursor`.
pub fn read_detached_run_text_since(
    directory: &Path,
    cursor: &mut DetachedRunJournalCursor,
) -> DetachedRunJournalRead<String> {
    let (lines, from_start, dropped) =
        read_journal_append(&detached_run_text_path(directory), cursor);
    DetachedRunJournalRead {
        entries: lines
            .iter()
            .filter_map(|line| parse_text_line(line))
            .collect(),
        from_start,
        dropped,
    }
}

/// Every activity entry the journal holds, oldest first.
pub fn read_detached_run_activity(directory: &Path) -> Vec<DetachedRunActivity> {
    read_activity_journal(&detached_run_activity_path(directory)).0
}

/// Only the entries appended past `cursor`.
pub fn read_detached_run_activity_since(
    directory: &Path,
    cursor: &mut DetachedRunJournalCursor,
) -> DetachedRunJournalRead<DetachedRunActivity> {
    let (lines, from_start, dropped) =
        read_journal_append(&detached_run_activity_path(directory), cursor);
    DetachedRunJournalRead {
        entries: lines
            .iter()
            .filter_map(|line| parse_activity_line(line))
            .collect(),
        from_start,
        dropped,
    }
}

/// Appends one chunk, then bounds the journal to the documented window.
pub fn append_detached_run_text(directory: &Path, text: &str) {
    let _ = std::fs::create_dir_all(directory);
    let path = detached_run_text_path(directory);
    let line = format!(
        "{}\n",
        crate::jsjson::stringify(&Value::String(text.to_string()))
    );
    let append_ok = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut file| file.write_all(line.as_bytes()))
        .is_ok();
    if !append_ok {
        return;
    }
    let Ok(size) = std::fs::metadata(&path).map(|metadata| metadata.len()) else {
        return;
    };
    if size <= JOURNAL_MAX_BYTES {
        return;
    }
    let (mut entries, dropped) = read_text_journal(&path);
    let keep_from = entries.len().saturating_sub(JOURNAL_MAX_ENTRIES);
    let discarded = dropped + keep_from as u64;
    entries.drain(..keep_from);
    let mut text = String::new();
    if discarded > 0 {
        text.push_str(&crate::jsjson::stringify(&json!({"dropped": discarded})));
        text.push('\n');
    }
    for chunk in entries {
        text.push_str(&crate::jsjson::stringify(&Value::String(chunk)));
        text.push('\n');
    }
    let _ = std::fs::write(&path, text);
}

/// Appends one entry, then bounds the journal to the documented window.
pub fn append_detached_run_activity(directory: &Path, activity: &DetachedRunActivity) {
    let _ = std::fs::create_dir_all(directory);
    let path = detached_run_activity_path(directory);
    let line = format!("{}\n", crate::jsjson::stringify(&activity.to_json()));
    let append_ok = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut file| file.write_all(line.as_bytes()))
        .is_ok();
    if !append_ok {
        return;
    }
    let Ok(size) = std::fs::metadata(&path).map(|metadata| metadata.len()) else {
        return;
    };
    if size <= JOURNAL_MAX_BYTES {
        return;
    }
    let (mut entries, dropped) = read_activity_journal(&path);
    let keep_from = entries.len().saturating_sub(JOURNAL_MAX_ENTRIES);
    let discarded = dropped + keep_from as u64;
    entries.drain(..keep_from);
    let mut text = String::new();
    if discarded > 0 {
        text.push_str(&crate::jsjson::stringify(&json!({"dropped": discarded})));
        text.push('\n');
    }
    for entry in entries {
        text.push_str(&crate::jsjson::stringify(&entry.to_json()));
        text.push('\n');
    }
    let _ = std::fs::write(&path, text);
}

// ---------------------------------------------------------------------------
// Commands

/// A dashboard-to-owner instruction; commands are consumed in name order.
#[derive(Debug, Clone, PartialEq)]
pub enum DetachedRunCommand {
    Prompt { seq: u64, text: String },
    Answer { id: AcpId, value: String },
    Stop,
    Pause,
    Resume,
}

impl DetachedRunCommand {
    pub fn to_json(&self) -> Value {
        match self {
            Self::Prompt { seq, text } => json!({"type": "prompt", "seq": seq, "text": text}),
            Self::Answer { id, value } => json!({
                "type": "answer",
                "id": serde_json::to_value(id).unwrap_or(Value::Null),
                "value": value,
            }),
            Self::Stop => json!({"type": "stop"}),
            Self::Pause => json!({"type": "pause"}),
            Self::Resume => json!({"type": "resume"}),
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        let value: Value = serde_json::from_str(text).ok()?;
        let record = value.as_object()?;
        match record.get("type")?.as_str()? {
            "stop" => Some(Self::Stop),
            "pause" => Some(Self::Pause),
            "resume" => Some(Self::Resume),
            "prompt" => Some(Self::Prompt {
                seq: record.get("seq")?.as_u64()?,
                text: record.get("text")?.as_str()?.to_string(),
            }),
            "answer" => Some(Self::Answer {
                id: AcpId::from_value(record.get("id")?)?,
                value: record.get("value")?.as_str()?.to_string(),
            }),
            _ => None,
        }
    }
}

static COMMAND_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Writes one instruction atomically; the owner consumes it in name order.
pub fn write_detached_run_command(directory: &Path, command: &DetachedRunCommand) {
    let _ = std::fs::create_dir_all(directory);
    let sequence = COMMAND_SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let name = format!("{now:014}-{sequence:06}.json");
    let _ = write_json(&directory.join(name), &command.to_json());
}

/// Reads and consumes every pending instruction in name order.
pub fn take_detached_run_commands(directory: &Path) -> Vec<DetachedRunCommand> {
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
        if let Some(command) = DetachedRunCommand::parse(&text) {
            commands.push(command);
        }
    }
    commands
}

// ---------------------------------------------------------------------------
// Lease and handoff

/// The current instance's lease, refreshed while the process lives.
pub fn write_detached_lease(
    state_dir: &Path,
    repo_dir: &Path,
    instance: &str,
) -> std::io::Result<()> {
    let updated_at = now_millis();
    let path = detached_run_lease_path(state_dir, repo_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // A lease is refreshed every second. Write it in place, padded to one
    // fixed-size buffer, instead of through a temporary file: the recorded
    // contract tree must never catch a staging name, and a reader always sees
    // one complete JSON document.
    let mut text = crate::jsjson::stringify(&json!({
        "pid": std::process::id(),
        "instance": instance,
        "updatedAt": updated_at,
    }));
    text.push('\n');
    text.push_str(&" ".repeat(LEASE_PADDING.saturating_sub(text.len())));
    use std::io::{Seek, SeekFrom, Write as _};
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(&path)?;
    file.seek(SeekFrom::Start(0))?;
    file.write_all(text.as_bytes())
}

/// The lease on disk, with its owner process and instance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetachedLease {
    pub pid: u32,
    pub instance: String,
    pub updated_at: i64,
}

pub fn read_detached_lease(state_dir: &Path, repo_dir: &Path) -> Option<DetachedLease> {
    let value = read_json(&detached_run_lease_path(state_dir, repo_dir))?;
    let record = value.as_object()?;
    let pid = record.get("pid")?.as_i64()?;
    if !(1..=u32::MAX as i64).contains(&pid) {
        return None;
    }
    Some(DetachedLease {
        pid: pid as u32,
        instance: record
            .get("instance")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        updated_at: record.get("updatedAt")?.as_i64()?,
    })
}

/// A replacement's handoff marker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DetachedHandoff {
    pub at: i64,
    pub pid: u32,
}

pub fn read_detached_handoff(state_dir: &Path, repo_dir: &Path) -> Option<DetachedHandoff> {
    let value = read_json(&detached_run_handoff_path(state_dir, repo_dir))?;
    let record = value.as_object()?;
    let at = record.get("at")?.as_i64()?;
    let pid = record.get("pid")?.as_i64()?;
    if !(1..=u32::MAX as i64).contains(&pid) {
        return None;
    }
    Some(DetachedHandoff {
        at,
        pid: pid as u32,
    })
}

pub fn write_detached_handoff(state_dir: &Path, repo_dir: &Path) {
    let _ = write_json(
        &detached_run_handoff_path(state_dir, repo_dir),
        &json!({"at": now_millis(), "pid": std::process::id()}),
    );
}

pub fn remove_detached_handoff(state_dir: &Path, repo_dir: &Path) {
    let _ = std::fs::remove_file(detached_run_handoff_path(state_dir, repo_dir));
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Handoff bookkeeping on the dashboard side

/// Repository keys whose runs a replacement has adopted. A `close()` during
/// the handoff window must not end a peer the replacement is about to own.
static HANDOFF_REPOS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn handoff_lock() -> MutexGuard<'static, Option<HashMap<String, String>>> {
    HANDOFF_REPOS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn detached_repo_key(repo_dir: &Path) -> String {
    repo_key(repo_dir)
}

/// Marks this instance's runs as belonging to the replacement.
pub fn begin_detached_handoff(state_dir: &Path, repo_dir: &Path, instance: &str) {
    if let Ok(mut repos) = HANDOFF_REPOS.lock() {
        repos
            .get_or_insert_with(HashMap::new)
            .insert(detached_repo_key(repo_dir), instance.to_string());
    }
    write_detached_handoff(state_dir, repo_dir);
}

/// Ends the handoff for one instance, or for every instance when omitted.
pub fn end_detached_handoff(state_dir: &Path, repo_dir: &Path, instance: Option<&str>) {
    let key = detached_repo_key(repo_dir);
    let mut guard = handoff_lock();
    if let Some(repos) = guard.as_mut() {
        let matches = instance.is_none()
            || repos
                .get(&key)
                .is_some_and(|value| instance.is_some_and(|wanted| value == wanted));
        if matches {
            repos.remove(&key);
        }
    }
    drop(guard);
    remove_detached_handoff(state_dir, repo_dir);
}

/// True for the instance that began the handoff; a successor never inherits it.
pub fn in_detached_handoff(repo_dir: &Path, instance: &str) -> bool {
    handoff_lock()
        .as_ref()
        .and_then(|repos| repos.get(&detached_repo_key(repo_dir)).cloned())
        .is_some_and(|value| value == instance)
}

/// What one detached run's record reports about itself: the lifecycle word and
/// whether the owner that runs it is still there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetachedRunLiveness {
    pub lifecycle: String,
    pub live: bool,
}

/// The lifecycle a detached run reports and whether it is live.
///
/// The recorded `status` alone proves nothing: an owner killed without writing
/// a terminal status (SIGKILL, an OOM kill, power loss) leaves `running` in
/// `state.json` forever, because nothing rewrites it. The owner process is the
/// authority, so a terminal status keeps its own word, a live owner keeps the
/// recorded word, and a running record whose owner is gone reports `stopped`
/// and is not live.
pub fn detached_run_liveness(state: &DetachedRunState) -> DetachedRunLiveness {
    if state.status.terminal() {
        return DetachedRunLiveness {
            lifecycle: state.status.as_str().to_string(),
            live: false,
        };
    }
    let owner_live = state
        .owner
        .as_ref()
        .is_some_and(|owner| crate::supervision::live_process(owner.pid));
    if owner_live {
        DetachedRunLiveness {
            lifecycle: state.status.as_str().to_string(),
            live: true,
        }
    } else {
        DetachedRunLiveness {
            lifecycle: "stopped".to_string(),
            live: false,
        }
    }
}

/// True while a run key has a live owner.
pub fn detached_run_live(
    state_dir: &Path,
    repo_dir: &Path,
    kind: &str,
    key: &str,
    instance: &str,
) -> bool {
    let directory = detached_run_directory(state_dir, repo_dir, kind, key);
    let Some(state) = read_detached_run_state(&directory) else {
        return false;
    };
    if !detached_run_liveness(&state).live {
        return false;
    }
    if state.instance == instance {
        return true;
    }
    read_detached_handoff(state_dir, repo_dir)
        .is_some_and(|handoff| now_millis() < handoff.at + DETACHED_HANDOFF_GRACE_MS)
}

/// True when a dashboard with this instance adopts the run's live owner here
/// and now instead of starting a fresh one, so the run journal keeps the
/// entries already written and a new turn's answer follows them.
pub fn detached_run_adoptable(
    state_dir: &Path,
    repo_dir: &Path,
    kind: &str,
    key: &str,
    instance: &str,
) -> bool {
    let directory = detached_run_directory(state_dir, repo_dir, kind, key);
    read_detached_run_state(&directory)
        .is_some_and(|state| adoptable(&directory, state_dir, repo_dir, instance, &state))
}

/// The adoption rule one handle shares with the state read above it.
fn adoptable(
    directory: &Path,
    state_dir: &Path,
    repo_dir: &Path,
    instance: &str,
    state: &DetachedRunState,
) -> bool {
    if detached_run_closed_path(directory).exists() {
        return false;
    }
    let Some(owner) = state.owner.as_ref() else {
        return false;
    };
    if !crate::supervision::live_process(owner.pid) || state.status.terminal() {
        return false;
    }
    // A live owner is adopted whether the replacement already recorded its own
    // instance or not.
    if state.instance == instance {
        return true;
    }
    // A second dashboard in this same process supervises the same owners; it
    // adopts them without a handoff.
    if state.launcher_pid == Some(std::process::id()) {
        return true;
    }
    read_detached_handoff(state_dir, repo_dir)
        .is_some_and(|handoff| now_millis() < handoff.at + DETACHED_HANDOFF_GRACE_MS)
}

// ---------------------------------------------------------------------------
// Dashboard handle

/// One callback for activity entries.
pub type ActivityCallback = Arc<dyn Fn(AcpActivity) + Send + Sync>;
/// One callback for assistant text chunks.
pub type TextCallback = Arc<dyn Fn(String) + Send + Sync>;
/// One callback for a question the peer waits on.
pub type QuestionCallback = Arc<dyn Fn(AcpQuestion) + Send + Sync>;
/// One callback for diagnostic stderr.
pub type StderrCallback = Arc<dyn Fn(String) + Send + Sync>;

/// Everything one dashboard handle needs to start or adopt a run.
#[derive(Clone)]
pub struct DetachedPeerOptions {
    pub repo_dir: PathBuf,
    pub state_dir: PathBuf,
    /// The run family, e.g. `discover`, `flow-implement`, `ask`.
    pub kind: String,
    /// Stable identity of this run across a replacement.
    pub key: String,
    /// The harness version that started this run.
    pub harness_version: Option<String>,
    /// The dashboard instance that owns this handle.
    pub instance: String,
    /// Activity entries the caller already holds; never emitted again.
    pub skip_activity: usize,
    /// Attach to an existing run and never start a new one.
    pub attach_only: bool,
    /// Accept further prompts on one peer session.
    pub multi: bool,
    pub command: String,
    pub cwd: String,
    /// The exact peer environment; `None` inherits the dashboard's own.
    pub env: Option<HashMap<String, String>>,
    pub permission: crate::acp::PermissionPolicy,
    pub on_activity: ActivityCallback,
    pub on_text: Option<TextCallback>,
    pub on_question: QuestionCallback,
    pub on_stderr: Option<StderrCallback>,
    /// Poll cadence; tests shorten it.
    pub poll_ms: u64,
}

impl DetachedPeerOptions {
    pub fn new(
        repo_dir: PathBuf,
        state_dir: PathBuf,
        kind: impl Into<String>,
        key: impl Into<String>,
        instance: impl Into<String>,
        command: impl Into<String>,
        cwd: impl Into<String>,
    ) -> Self {
        Self {
            repo_dir,
            state_dir,
            kind: kind.into(),
            key: key.into(),
            harness_version: None,
            instance: instance.into(),
            skip_activity: 0,
            attach_only: false,
            multi: false,
            command: command.into(),
            cwd: cwd.into(),
            env: None,
            permission: crate::acp::PermissionPolicy::Allow,
            on_activity: Arc::new(|_| {}),
            on_text: None,
            on_question: Arc::new(|_| {}),
            on_stderr: None,
            poll_ms: 50,
        }
    }

    pub fn activity(mut self, callback: ActivityCallback) -> Self {
        self.on_activity = callback;
        self
    }

    pub fn text(mut self, callback: TextCallback) -> Self {
        self.on_text = Some(callback);
        self
    }

    pub fn question(mut self, callback: QuestionCallback) -> Self {
        self.on_question = callback;
        self
    }

    pub fn stderr(mut self, callback: StderrCallback) -> Self {
        self.on_stderr = Some(callback);
        self
    }

    pub fn multi(mut self, multi: bool) -> Self {
        self.multi = multi;
        self
    }

    pub fn attach_only(mut self, attach_only: bool) -> Self {
        self.attach_only = attach_only;
        self
    }

    pub fn skip_activity(mut self, skip: usize) -> Self {
        self.skip_activity = skip;
        self
    }

    pub fn env(mut self, env: HashMap<String, String>) -> Self {
        self.env = Some(env);
        self
    }

    pub fn permission(mut self, permission: crate::acp::PermissionPolicy) -> Self {
        self.permission = permission;
        self
    }

    pub fn harness_version(mut self, version: Option<String>) -> Self {
        self.harness_version = version;
        self
    }

    pub fn poll_ms(mut self, poll_ms: u64) -> Self {
        self.poll_ms = poll_ms.max(1);
        self
    }
}

/// Why a run handle closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CloseReason {
    Stopped,
    Preserved,
}

/// How a run settled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DetachedRunOutcome {
    Completed,
    Stopped,
    Attached,
    Preserved,
}

struct PeerInner {
    options: DetachedPeerOptions,
    directory: PathBuf,
    control: PathBuf,
    activity_cursor: Mutex<DetachedRunJournalCursor>,
    text_cursor: Mutex<DetachedRunJournalCursor>,
    seen_activity: Mutex<usize>,
    seen_text: Mutex<usize>,
    last_question: Mutex<Option<String>>,
    next_turn: Mutex<u64>,
    last_turn_seq: Mutex<u64>,
    first_resolved: AtomicBool,
    paused: AtomicBool,
    closed: AtomicBool,
    preserved: AtomicBool,
    close_reason: Mutex<Option<CloseReason>>,
    failure: Mutex<Option<String>>,
    state: Mutex<Option<DetachedRunState>>,
    owner_pid: Mutex<Option<u32>>,
    tick: Mutex<Option<tokio::sync::watch::Sender<u64>>>,
}

impl PeerInner {
    fn bump(&self) {
        if let Ok(mut tick) = self.tick.lock() {
            if let Some(sender) = tick.as_mut() {
                let next = *sender.borrow() + 1;
                let _ = sender.send(next);
            }
        }
    }

    fn subscribe(&self) -> tokio::sync::watch::Receiver<u64> {
        let mut guard = self
            .tick
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if guard.is_none() {
            let (sender, receiver) = tokio::sync::watch::channel(0u64);
            *guard = Some(sender);
            return receiver;
        }
        guard.as_ref().expect("a sender").subscribe()
    }
}

/// The dashboard handle to a detached run.
pub struct DetachedPeer {
    inner: Arc<PeerInner>,
}

impl DetachedPeer {
    /// Creates one handle and starts observing its state directory.
    pub fn new(options: DetachedPeerOptions) -> Arc<Self> {
        let directory = detached_run_directory(
            &options.state_dir,
            &options.repo_dir,
            &options.kind,
            &options.key,
        );
        let control = detached_run_control_directory(&directory);
        let inner = Arc::new(PeerInner {
            options,
            directory,
            control,
            activity_cursor: Mutex::new(DetachedRunJournalCursor::default()),
            text_cursor: Mutex::new(DetachedRunJournalCursor::default()),
            seen_activity: Mutex::new(0),
            seen_text: Mutex::new(0),
            last_question: Mutex::new(None),
            next_turn: Mutex::new(0),
            last_turn_seq: Mutex::new(0),
            first_resolved: AtomicBool::new(false),
            paused: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            preserved: AtomicBool::new(false),
            close_reason: Mutex::new(None),
            failure: Mutex::new(None),
            state: Mutex::new(None),
            owner_pid: Mutex::new(None),
            tick: Mutex::new(None),
        });
        {
            let mut seen = inner
                .seen_activity
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *seen = inner.options.skip_activity;
        }
        let peer = Arc::new(Self { inner });
        let polling = Arc::clone(&peer);
        let poll_ms = peer.inner.options.poll_ms;
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(poll_ms)).await;
                polling.poll_once();
                if polling.inner.closed.load(Ordering::SeqCst) {
                    break;
                }
            }
        });
        peer
    }

    pub fn directory(&self) -> &Path {
        &self.inner.directory
    }

    pub fn closed(&self) -> bool {
        self.inner.closed.load(Ordering::SeqCst)
    }

    /// The real ACP peer, recorded by its owner.
    pub fn pid(&self) -> Option<u32> {
        self.state()
            .and_then(|state| state.peer)
            .map(|child| child.pid)
    }

    pub fn argv(&self) -> Vec<String> {
        self.state()
            .and_then(|state| state.peer)
            .map(|child| child.argv)
            .unwrap_or_default()
    }

    /// The owner process itself, observable by fixtures and diagnostics.
    pub fn owner_pid(&self) -> Option<u32> {
        if let Some(state) = self.state() {
            if let Some(owner) = state.owner {
                return Some(owner.pid);
            }
        }
        *self
            .inner
            .owner_pid
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The newest state this handle read.
    pub fn state(&self) -> Option<DetachedRunState> {
        if let Ok(state) = self.inner.state.lock() {
            if state.is_some() {
                return state.clone();
            }
        }
        read_detached_run_state(&self.inner.directory)
    }

    /// Marks this run as owned by the replacement rather than this process.
    pub fn preserve(&self) {
        self.inner.preserved.store(true, Ordering::SeqCst);
    }

    /// Starts the run, or attaches to the live one a previous dashboard
    /// started. The returned future settles with the run's own outcome, or
    /// with the first turn's outcome for a conversation.
    pub async fn run(&self, prompt: &str) -> Result<DetachedRunOutcome, String> {
        let existing = read_detached_run_state(&self.inner.directory);
        if self.inner.options.attach_only {
            let Some(existing) = existing else {
                return Err(format!(
                    "No detached {} run exists.",
                    self.inner.options.kind
                ));
            };
            self.adopt(existing);
            if self.inner.options.multi {
                return Ok(DetachedRunOutcome::Attached);
            }
            return self.wait_outcome().await;
        }
        if let Some(existing) = existing {
            if self.live(&existing) {
                // A conversation owner keeps its session and its journal, so a
                // turn is delivered to it: an adopted owner that the prompt
                // never reached would replay its earlier answer instead.
                let pending = existing
                    .turn_seq
                    .filter(|_| existing.turn_status == Some(DetachedTurnStatus::Running));
                self.adopt(existing);
                if self.inner.options.multi {
                    // The owner drops a prompt that arrives while a turn runs,
                    // so the turn in flight settles before this one is sent.
                    if let Some(seq) = pending {
                        self.wait_turn(seq).await?;
                    }
                    self.turn_prompt(prompt).await?;
                    return Ok(DetachedRunOutcome::Completed);
                }
                return self.wait_outcome().await;
            }
            if existing
                .owner
                .as_ref()
                .is_some_and(|owner| crate::supervision::live_process(owner.pid))
            {
                write_detached_run_command(&self.inner.control, &DetachedRunCommand::Stop);
                let deadline = std::time::Instant::now() + Duration::from_millis(2_000);
                while existing
                    .owner
                    .as_ref()
                    .is_some_and(|owner| crate::supervision::live_process(owner.pid))
                    && std::time::Instant::now() < deadline
                {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            }
        }
        self.start(prompt)?;
        self.wait_outcome().await
    }

    /// Waits for one turn already running on the owner, without sending one.
    pub async fn wait_turn(&self, seq: u64) -> Result<(), String> {
        self.wait_until(|state, _| {
            state
                .as_ref()
                .map(|state| turn_settled(state, seq))
                .unwrap_or(false)
        })
        .await?;
        let state = self.state();
        if let Some(state) = state {
            if state.turn_status == Some(DetachedTurnStatus::Failed) {
                return Err(state
                    .turn_error
                    .unwrap_or_else(|| "the turn failed".to_string()));
            }
        }
        Ok(())
    }

    /// A conversation owner accepts a follow-up prompt on the same peer.
    pub async fn prompt(&self, prompt: &str) -> Result<(), String> {
        if !self.inner.options.multi {
            self.run(prompt).await.map(|_| ())
        } else {
            self.turn_prompt(prompt).await
        }
    }

    /// Writes the next turn's prompt to the conversation owner and waits for
    /// that turn to settle.
    async fn turn_prompt(&self, prompt: &str) -> Result<(), String> {
        let seq = {
            let mut next = self
                .inner
                .next_turn
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let last = *self
                .inner
                .last_turn_seq
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *next = (*next).max(last) + 1;
            *next
        };
        write_detached_run_command(
            &self.inner.control,
            &DetachedRunCommand::Prompt {
                seq,
                text: prompt.to_string(),
            },
        );
        self.wait_turn(seq).await
    }

    pub fn answer(&self, id: &AcpId, value: &str) -> bool {
        if self.closed() {
            return false;
        }
        // An answer can arrive before this peer's first poll has read the
        // owner's state. The owner's file is authoritative.
        let Some(state) = read_detached_run_state(&self.inner.directory) else {
            return false;
        };
        let Some(question) = state.question else {
            return false;
        };
        if question.id.as_key() != id.as_key() {
            return false;
        }
        write_detached_run_command(
            &self.inner.control,
            &DetachedRunCommand::Answer {
                id: id.clone(),
                value: value.to_string(),
            },
        );
        true
    }

    pub fn pause(&self) -> bool {
        if self.closed() {
            return false;
        }
        self.poll_once();
        self.inner.paused.store(true, Ordering::SeqCst);
        write_detached_run_command(&self.inner.control, &DetachedRunCommand::Pause);
        true
    }

    pub fn resume(&self) -> bool {
        if self.closed() {
            return false;
        }
        self.inner.paused.store(false, Ordering::SeqCst);
        write_detached_run_command(&self.inner.control, &DetachedRunCommand::Resume);
        true
    }

    pub fn close(&self) {
        if self.inner.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        let preserved = self.inner.preserved.load(Ordering::SeqCst)
            || in_detached_handoff(&self.inner.options.repo_dir, &self.inner.options.instance);
        if preserved {
            *self
                .inner
                .close_reason
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(CloseReason::Preserved);
            self.inner.bump();
            return;
        }
        let _ = std::fs::write(
            detached_run_closed_path(&self.inner.directory),
            format!("{}\n", now_millis()),
        );
        write_detached_run_command(&self.inner.control, &DetachedRunCommand::Stop);
        *self
            .inner
            .close_reason
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(CloseReason::Stopped);
        self.inner.bump();
    }

    /// Adopts the state a live owner already published.
    fn adopt(&self, state: DetachedRunState) {
        {
            let mut last_question = self
                .inner
                .last_question
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *last_question = state
                .question
                .as_ref()
                .and_then(|question| serde_json::to_string(question).ok());
        }
        {
            let mut last_turn = self
                .inner
                .last_turn_seq
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *last_turn = state.turn_seq.unwrap_or(0);
        }
        if let Ok(mut stored) = self.inner.state.lock() {
            *stored = Some(state);
        }
        self.poll_once();
    }

    fn live(&self, state: &DetachedRunState) -> bool {
        adoptable(
            &self.inner.directory,
            &self.inner.options.state_dir,
            &self.inner.options.repo_dir,
            &self.inner.options.instance,
            state,
        )
    }

    fn start(&self, prompt: &str) -> Result<(), String> {
        reset_detached_run(&self.inner.directory);
        let now = crate::journal::now_iso8601();
        let generation = uuid::Uuid::new_v4().to_string();
        let multi = self.inner.options.multi;
        let state = DetachedRunState {
            version: DETACHED_RUN_VERSION,
            kind: self.inner.options.kind.clone(),
            key: self.inner.options.key.clone(),
            repo: absolute(&self.inner.options.repo_dir).display().to_string(),
            state_dir: absolute(&self.inner.options.state_dir)
                .display()
                .to_string(),
            harness_version: self.inner.options.harness_version.clone(),
            instance: self.inner.options.instance.clone(),
            launcher_pid: Some(std::process::id()),
            generation: generation.clone(),
            multi,
            turn_seq: multi.then_some(0),
            turn_status: multi.then_some(DetachedTurnStatus::Idle),
            turn_error: None,
            status: DetachedRunStatus::Starting,
            started_at: now.clone(),
            finished_at: None,
            error: None,
            question: None,
            owner: None,
            peer: None,
            updated_at: now,
        };
        write_detached_run_state(&self.inner.directory, &state)
            .map_err(|error| error.to_string())?;
        std::fs::write(detached_run_prompt_path(&self.inner.directory), prompt)
            .map_err(|error| error.to_string())?;
        let argv = self.owner_argv(&generation);
        let pid = spawn_owner(&argv, &self.inner.options.repo_dir, &self.environment())
            .ok_or_else(|| format!("The {} run owner could not start.", self.inner.options.kind))?;
        if let Ok(mut owner) = self.inner.owner_pid.lock() {
            *owner = Some(pid);
        }
        Ok(())
    }

    fn owner_argv(&self, generation: &str) -> Vec<String> {
        let executable = owner_executable();
        let permission = match self.inner.options.permission {
            crate::acp::PermissionPolicy::Allow => "allow",
            crate::acp::PermissionPolicy::Deny => "deny",
            crate::acp::PermissionPolicy::ReadOnly => "read-only",
        };
        let mut argv = vec![
            executable.display().to_string(),
            "worker".to_string(),
            "run-owner".to_string(),
            "--repo".to_string(),
            absolute(&self.inner.options.repo_dir).display().to_string(),
            "--state-dir".to_string(),
            absolute(&self.inner.options.state_dir)
                .display()
                .to_string(),
            "--kind".to_string(),
            self.inner.options.kind.clone(),
            "--key".to_string(),
            self.inner.options.key.clone(),
            "--generation".to_string(),
            generation.to_string(),
            "--command".to_string(),
            self.inner.options.command.clone(),
            "--cwd".to_string(),
            self.inner.options.cwd.clone(),
            "--permission".to_string(),
            permission.to_string(),
        ];
        if self.inner.options.multi {
            argv.push("--multi".to_string());
        }
        if let Some(version) = &self.inner.options.harness_version {
            argv.push("--harness-version".to_string());
            argv.push(version.clone());
        }
        argv
    }

    fn environment(&self) -> HashMap<String, String> {
        let mut environment: HashMap<String, String> = std::env::vars().collect();
        if let Some(extra) = &self.inner.options.env {
            for (key, value) in extra {
                environment.insert(key.clone(), value.clone());
            }
        }
        environment
    }

    async fn wait_outcome(&self) -> Result<DetachedRunOutcome, String> {
        let multi = self.inner.options.multi;
        self.wait_until(move |state, _inner| {
            let Some(state) = state else {
                return false;
            };
            if multi {
                turn_settled(state, 1) || state.status.terminal()
            } else {
                state.status.terminal()
            }
        })
        .await?;
        self.outcome()
    }

    fn outcome(&self) -> Result<DetachedRunOutcome, String> {
        let reason = *self
            .inner
            .close_reason
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(failure) = self
            .inner
            .failure
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
        {
            return Err(failure);
        }
        match reason {
            Some(CloseReason::Preserved) => return Ok(DetachedRunOutcome::Preserved),
            Some(CloseReason::Stopped) => return Ok(DetachedRunOutcome::Stopped),
            None => {}
        }
        let Some(state) = self.state() else {
            return Err(format!(
                "No detached {} run exists.",
                self.inner.options.kind
            ));
        };
        if self.inner.options.multi
            && state.turn_seq.unwrap_or(0) >= 1
            && state
                .turn_status
                .is_some_and(|status| status != DetachedTurnStatus::Running)
        {
            return if state.turn_status == Some(DetachedTurnStatus::Failed) {
                Err(state
                    .turn_error
                    .unwrap_or_else(|| "the turn failed".to_string()))
            } else {
                Ok(DetachedRunOutcome::Completed)
            };
        }
        match state.status {
            DetachedRunStatus::Succeeded => Ok(DetachedRunOutcome::Completed),
            DetachedRunStatus::Stopped => Ok(DetachedRunOutcome::Stopped),
            DetachedRunStatus::Failed => {
                Err(state.error.unwrap_or_else(|| "the run failed".to_string()))
            }
            DetachedRunStatus::Starting | DetachedRunStatus::Running => {
                Err("The run owner exited before the run finished.".to_string())
            }
        }
    }

    async fn wait_until<F>(&self, predicate: F) -> Result<(), String>
    where
        F: Fn(Option<&DetachedRunState>, &PeerInner) -> bool,
    {
        loop {
            // Subscribe before reading the durable state, so a poll that lands
            // between the read and the wait still wakes this waiter, while the
            // waiter's own read never bumps the watch.
            let mut receiver = self.inner.subscribe();
            self.poll_once();
            if self.closed_reason().is_some() {
                return Ok(());
            }
            if let Some(failure) = self
                .inner
                .failure
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
            {
                return Err(failure);
            }
            let state = self.state();
            if predicate(state.as_ref(), &self.inner) {
                return Ok(());
            }
            let _ = receiver.changed().await;
        }
    }

    fn closed_reason(&self) -> Option<CloseReason> {
        *self
            .inner
            .close_reason
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Reads the owner's published state and both journals once.
    fn poll_once(&self) {
        let Some(state) = read_detached_run_state(&self.inner.directory) else {
            return;
        };
        if let Ok(mut stored) = self.inner.state.lock() {
            *stored = Some(state.clone());
        }
        let paused = self.inner.paused.load(Ordering::SeqCst);
        let activity = {
            let mut cursor = self
                .inner
                .activity_cursor
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            read_detached_run_activity_since(&self.inner.directory, &mut cursor)
        };
        let seen = *self
            .inner
            .seen_activity
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let consumed = consume(activity, seen);
        *self
            .inner
            .seen_activity
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = consumed.1;
        if !paused {
            for entry in consumed.0 {
                (self.inner.options.on_activity)(AcpActivity {
                    text: entry.text,
                    append: entry.append,
                });
            }
        }
        let text = {
            let mut cursor = self
                .inner
                .text_cursor
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            read_detached_run_text_since(&self.inner.directory, &mut cursor)
        };
        let seen = *self
            .inner
            .seen_text
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let consumed = consume(text, seen);
        *self
            .inner
            .seen_text
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = consumed.1;
        if !paused {
            if let Some(callback) = &self.inner.options.on_text {
                for chunk in consumed.0 {
                    callback(chunk);
                }
            }
        }
        if state.multi {
            let seq = state.turn_seq.unwrap_or(0);
            let status = state.turn_status.unwrap_or(DetachedTurnStatus::Idle);
            if !self.inner.first_resolved.load(Ordering::SeqCst)
                && seq >= 1
                && status != DetachedTurnStatus::Running
            {
                self.inner.first_resolved.store(true, Ordering::SeqCst);
            }
            if seq > 0 && status != DetachedTurnStatus::Running {
                let mut last = self
                    .inner
                    .last_turn_seq
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if seq > *last {
                    *last = seq;
                }
            }
        }
        let question = state
            .question
            .as_ref()
            .and_then(|question| serde_json::to_string(question).ok());
        let changed = {
            let mut last = self
                .inner
                .last_question
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if question != *last {
                *last = question.clone();
                true
            } else {
                false
            }
        };
        if changed {
            if let Some(question) = &state.question {
                (self.inner.options.on_question)(question.clone());
            }
        }
        if !state.status.terminal() {
            if state.multi {
                if let Some(peer) = &state.peer {
                    if !crate::supervision::live_process(peer.pid) {
                        self.fail(
                            state
                                .error
                                .clone()
                                .unwrap_or_else(|| "The ask agent exited.".to_string()),
                        );
                        return;
                    }
                }
            }
            if let Some(owner) = &state.owner {
                if !crate::supervision::live_process(owner.pid)
                    && state.status != DetachedRunStatus::Starting
                {
                    self.fail(state.error.clone().unwrap_or_else(|| {
                        "The run owner exited before the run finished.".to_string()
                    }));
                    return;
                }
            }
        }
        self.inner.bump();
    }

    fn fail(&self, message: String) {
        if let Ok(mut failure) = self.inner.failure.lock() {
            if failure.is_none() {
                *failure = Some(message);
            }
        }
        self.inner.closed.store(true, Ordering::SeqCst);
        self.inner.bump();
    }
}

fn turn_settled(state: &DetachedRunState, seq: u64) -> bool {
    state.turn_seq.unwrap_or(0) >= seq
        && state
            .turn_status
            .is_some_and(|status| status != DetachedTurnStatus::Running)
}

/// Drops the entries this peer already delivered. `seen` counts every entry
/// the run ever appended; the journal's header re-bases that count onto the
/// file its bound rewrote.
fn consume<T: Clone>(read: DetachedRunJournalRead<T>, seen: usize) -> (Vec<T>, usize) {
    if read.from_start {
        let base = seen
            .saturating_sub(read.dropped as usize)
            .min(read.entries.len());
        (
            read.entries[base..].to_vec(),
            read.dropped as usize + read.entries.len(),
        )
    } else {
        let total = seen + read.entries.len();
        (read.entries, total)
    }
}

/// The harness binary that runs a detached owner. A production dashboard is
/// its own owner executable; a test binary under `target/debug/deps` names the
/// `devboard` binary beside it instead.
fn owner_executable() -> PathBuf {
    if let Some(path) = std::env::var("DEVBOARD_OWNER_EXECUTABLE")
        .ok()
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
    {
        return path;
    }
    let current = crate::relaunch::own_program();
    if current.file_name().is_some_and(|name| name == "devboard") {
        return current;
    }
    if let Some(sibling) = current
        .parent()
        .and_then(Path::parent)
        .map(|parent| parent.join("devboard"))
    {
        if sibling.is_file() {
            return sibling;
        }
    }
    current
}

/// Starts one detached owner in its own session with ignored stdio.
pub fn spawn_owner(
    argv: &[String],
    cwd: &Path,
    environment: &HashMap<String, String>,
) -> Option<u32> {
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
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Some(pid)
}

// ---------------------------------------------------------------------------
// Recorded children

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

/// The canonical form a process table entry reports for a directory.
pub fn canonical_process_path(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

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

/// Ends every recorded child whose process table entry proves it is the peer
/// the killed process left behind, and waits until it is gone.
pub async fn terminate_recorded_children(
    children: &[RecordedChild],
    timeout_ms: u64,
) -> Vec<RecordedChild> {
    let proven: Vec<RecordedChild> = children
        .iter()
        .filter(|child| recorded_child_alive(child))
        .cloned()
        .collect();
    for child in &proven {
        unsafe {
            libc::kill(child.pid as libc::pid_t, libc::SIGKILL);
        }
    }
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    while std::time::Instant::now() < deadline && proven.iter().any(recorded_child_alive) {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    proven
}
