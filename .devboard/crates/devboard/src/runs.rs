//! One output socket per live ACP run.
//!
//! Every run keeps a retained journal of its state, question, activity,
//! assistant text, diagnostics, and terminal status. A socket replays that
//! journal from a cursor and then follows it live. No frame carries another
//! run's identity or any workspace state.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, Request};
use axum::http::{header, HeaderMap, Method};
use axum::response::Response;
use serde_json::{json, Map, Value};
use url::Url;

use crate::app::App;
use crate::detached_run::{
    detached_run_state_path, detached_runs_root, read_detached_run_activity_since,
    read_detached_run_state, read_detached_run_text_since, DetachedRunJournalCursor,
};
use crate::http::{Replies, Server};
use crate::workers::{mcp_optimizer, release_train, watchdog, FAMILIES};

/// The retained window of one run's output journal.
pub const RUN_OUTPUT_WINDOW: usize = 1000;
/// How often one run's state is sampled. Every socket for that run shares
/// the one sample: the interval bounds the reads, never the number of
/// viewers.
const RUN_POLL_MS: u64 = 500;
/// How often the run's activity journals are checked for an appended line.
/// A check costs one `stat`; the file is read only when its stamp changed.
const RUN_ACTIVITY_MS: u64 = 250;
/// How often `RunHub` drops the journals of runs this dashboard no longer
/// discovers, so a process that streamed many runs keeps one journal per run
/// it can still serve rather than one per run it has ever served.
pub const RUN_JOURNAL_SWEEP_MS: u64 = 30_000;
/// How long a journal survives after its run was last seen live once that run
/// leaves the discovered set, so a run whose record is being rewritten keeps
/// its retained window and its cursors.
const RUN_JOURNAL_GRACE_MS: u64 = 60_000;

/// One run's durable source.
#[derive(Clone)]
pub enum Source {
    /// A detached owner's run directory.
    Detached(PathBuf),
    /// A background family worker's state file and activity file.
    Worker {
        state_path: PathBuf,
        activity_path: Option<PathBuf>,
        family: String,
    },
    /// One worker-run record under the Issues state directory.
    Issues {
        run_path: PathBuf,
        activity_path: PathBuf,
    },
}

/// One discoverable run.
#[derive(Clone)]
pub struct RunSource {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub lifecycle: String,
    pub live: bool,
    pub updated_at: Option<String>,
    pub source: Source,
}

impl RunSource {
    /// The run's current durable state.
    pub fn state(&self) -> Option<Arc<Value>> {
        match &self.source {
            Source::Detached(directory) => {
                let state = read_detached_run_state(directory)?;
                Some(Arc::new(state.to_json()))
            }
            Source::Worker { state_path, .. } => crate::sampling::json(state_path),
            Source::Issues { run_path, .. } => crate::sampling::json(run_path),
        }
    }

    /// The run's lifecycle string, read from its state.
    pub fn current_lifecycle(&self) -> String {
        self.lifecycle_of(self.state().as_deref())
    }

    /// The lifecycle one already-sampled state names.
    pub fn lifecycle_of(&self, state: Option<&Value>) -> String {
        let Some(state) = state else {
            return "stopped".to_string();
        };
        match &self.source {
            Source::Detached(_) => state
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("stopped")
                .to_string(),
            Source::Worker { .. } => worker_lifecycle(state),
            Source::Issues { .. } => issue_run_lifecycle(state),
        }
    }

    /// True while the run may still produce output.
    pub fn current_live(&self) -> bool {
        self.live_of(self.state().as_deref())
    }

    /// Whether the run is live, from one already-sampled state.
    pub fn live_of(&self, state: Option<&Value>) -> bool {
        let Some(state) = state else {
            return false;
        };
        match &self.source {
            Source::Worker { .. } => worker_run_live(state),
            Source::Issues { .. } => live_lifecycle(&issue_run_lifecycle(state)),
            Source::Detached(_) => live_lifecycle(
                state
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("stopped"),
            ),
        }
    }
}

/// True when `interval_ms` elapsed since the last sample, or none was taken.
fn elapsed(last: Option<Instant>, now: Instant, interval_ms: u64) -> bool {
    last.map(|last| now.saturating_duration_since(last) >= Duration::from_millis(interval_ms))
        .unwrap_or(true)
}

/// One file's `(modified, len)`, the stamp an activity check compares.
fn stamp_of(path: &Path) -> Option<(SystemTime, u64)> {
    crate::sampling::stamp(path)
}

fn live_lifecycle(lifecycle: &str) -> bool {
    !matches!(
        lifecycle,
        "stopped" | "failed" | "succeeded" | "idle" | "done"
    )
}

/// The lifecycle one Issues run record represents. A record still says
/// `running` after its worker died; the recorded pid and its kernel start tick
/// are the authority, so a dead or recycled worker is reported stopped without
/// rewriting the record.
fn issue_run_lifecycle(state: &Value) -> String {
    let status = state
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("stopped");
    if !live_lifecycle(status) {
        return status.to_string();
    }
    match state.get("workerPid").and_then(Value::as_u64) {
        Some(pid) if (1..=u32::MAX as u64).contains(&pid) => {
            let start_ticks = state.get("startTicks").and_then(Value::as_i64);
            if crate::supervision::live_identity(pid as u32, start_ticks) {
                status.to_string()
            } else {
                "stopped".to_string()
            }
        }
        _ => status.to_string(),
    }
}

/// A family worker is live while the process its record names still runs;
/// between cycles its lifecycle is `idle` but the worker still serves the
/// family. The recorded pid alone proves nothing, because the kernel reuses it:
/// the start tick written beside that pid must match the live process. The
/// repository-scoped families nest the pair under `worker`; the families that
/// publish a flat record put it at the top level.
fn worker_run_live(state: &Value) -> bool {
    let recorded = state
        .get("worker")
        .and_then(|worker| worker.get("pid"))
        .and_then(Value::as_u64)
        .or_else(|| state.get("pid").and_then(Value::as_u64));
    if let Some(pid) = recorded {
        if (1..=u32::MAX as u64).contains(&pid) {
            let start_ticks = state
                .get("worker")
                .and_then(|worker| worker.get("startTicks"))
                .and_then(Value::as_i64)
                .or_else(|| state.get("startTicks").and_then(Value::as_i64));
            return crate::supervision::live_identity(pid as u32, start_ticks);
        }
    }
    !matches!(
        state
            .get("lifecycle")
            .and_then(Value::as_str)
            .unwrap_or("stopped"),
        "stopped" | "failed"
    )
}

fn worker_lifecycle(state: &Value) -> String {
    let raw = state
        .get("lifecycle")
        .and_then(Value::as_str)
        .unwrap_or("stopped");
    match raw {
        "stopped" | "failed" => raw.to_string(),
        // The recorded pid is the authority: a record still says `running`
        // after its worker died, so that record's lifecycle is stopped.
        _ if !worker_run_live(state) => "stopped".to_string(),
        _ if state.get("draining") == Some(&Value::Bool(true)) => "stopping".to_string(),
        _ => "running".to_string(),
    }
}

fn read_activity(path: &Path) -> Vec<String> {
    crate::sampling::json(path)
        .and_then(|value| value.as_array().cloned())
        .map(|entries| {
            entries
                .into_iter()
                .filter_map(|entry| entry.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// The activity file a sampled family state names, resolved by that family's
/// own layout rather than by one guess: the Scout names its newest scan, the
/// Release Train its run directory, and every cycle family its newest or
/// active cycle.
fn worker_activity_path(
    state_dir: &Path,
    repo_dir: &Path,
    family: &str,
    state: &Value,
) -> Option<PathBuf> {
    match family {
        "scout" => crate::workers::scout::state_activity_path(repo_dir, state),
        "release-train" => crate::workers::release_train::state_activity_path(
            &crate::workers::release_train::release_train_directory(state_dir),
            state,
        ),
        _ => {
            let cycle = state
                .get("newestCycleId")
                .and_then(Value::as_str)
                .or_else(|| state.get("activeCycleId").and_then(Value::as_str))?;
            Some(
                repo_dir
                    .join(".devboard")
                    .join(".tmp")
                    .join(family)
                    .join("cycles")
                    .join(cycle)
                    .join("activity.json"),
            )
        }
    }
}

/// One version directory's label: the directory's own name.
fn version_label(directory: &Path) -> String {
    directory
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "unknown".to_string())
}

/// The repository-scoped families publish one `state.json` per repository and
/// one per worker version under `<state>/<family>/<key>`.
fn repo_scoped_worker_states(
    state_dir: &Path,
    repo_dir: &Path,
    family: &str,
) -> Vec<(String, PathBuf)> {
    let root = state_dir
        .join(family)
        .join(crate::journal::journal_key(repo_dir));
    let mut states = Vec::new();
    let legacy = root.join("state.json");
    if legacy.is_file() {
        states.push((version_label(&root), legacy));
    }
    if let Ok(entries) = std::fs::read_dir(root.join("workers")) {
        for entry in entries.flatten() {
            let path = entry.path().join("state.json");
            if path.is_file() {
                states.push((version_label(&entry.path()), path));
            }
        }
    }
    states
}

/// The flat published worker records under one family directory: the legacy
/// record at its root, when the family writes one, and one record per
/// version directory.
fn flat_worker_states(
    directory: &Path,
    versions: Vec<PathBuf>,
    record: fn(&Path) -> PathBuf,
) -> Vec<(String, PathBuf)> {
    let mut states = Vec::new();
    let legacy = record(directory);
    if legacy.is_file() {
        states.push(("legacy".to_string(), legacy));
    }
    for version in versions {
        states.push((version_label(&version), record(&version)));
    }
    states
}

/// Every worker state file one background family publishes, with the version
/// label each path names.
///
/// The repository-scoped families keep `state.json`; the MCP optimizer, the
/// Release Train, and the Watchdog publish a flat `worker.json` under their
/// own directory instead, and the Watchdog's lives beside the repository
/// rather than in the state directory.
fn family_worker_states(state_dir: &Path, repo_dir: &Path, family: &str) -> Vec<(String, PathBuf)> {
    match family {
        "watchdog" => {
            let directory = watchdog::watchdog_directory(repo_dir);
            flat_worker_states(
                &directory,
                watchdog::worker_state_directories(&directory),
                watchdog::worker_state_path,
            )
        }
        "mcp-optimizer" => {
            let directory = mcp_optimizer::mcp_optimizer_directory(state_dir);
            flat_worker_states(
                &directory,
                mcp_optimizer::worker_state_directories(&directory),
                mcp_optimizer::worker_state_path,
            )
        }
        "release-train" => {
            let directory = release_train::release_train_directory(state_dir);
            release_train::worker_state_directories(&directory)
                .into_iter()
                .map(|version| {
                    let label = version_label(&version);
                    let path = release_train::versioned_worker_state_path(&directory, Some(&label));
                    (label, path)
                })
                .collect()
        }
        _ => repo_scoped_worker_states(state_dir, repo_dir, family),
    }
}

/// Every run this dashboard can see, newest state first.
///
/// Each state file is sampled through the `(mtime, len)` cache, so a
/// collection read costs one `stat` per record and one content read only for
/// a record that changed.
pub fn discover(app: &App) -> Vec<RunSource> {
    let state_dir = &app.config().state_dir;
    let repo_dir = &app.config().repo_dir;
    let mut runs = Vec::new();

    if let Ok(entries) = std::fs::read_dir(detached_runs_root(state_dir, repo_dir)) {
        for entry in entries.flatten() {
            let directory = entry.path();
            if !directory.is_dir() || !detached_run_state_path(&directory).is_file() {
                continue;
            }
            let Some(state) = read_detached_run_state(&directory) else {
                continue;
            };
            let id = directory
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            if id.is_empty() {
                continue;
            }
            let lifecycle = state.status.as_str().to_string();
            runs.push(RunSource {
                id,
                kind: state.kind.clone(),
                label: format!("{} {}", state.kind, state.key),
                lifecycle: lifecycle.clone(),
                live: live_lifecycle(&lifecycle),
                updated_at: Some(state.updated_at.clone()),
                source: Source::Detached(directory),
            });
        }
    }

    for family in FAMILIES {
        for (version, state_path) in family_worker_states(state_dir, repo_dir, family) {
            let Some(state) = crate::sampling::json(&state_path) else {
                continue;
            };
            if state.get("lifecycle").and_then(Value::as_str).is_none() {
                continue;
            }
            let lifecycle = worker_lifecycle(&state);
            let id = format!("{family}--{version}");
            let activity_path = worker_activity_path(state_dir, repo_dir, family, &state);
            let live = worker_run_live(&state);
            runs.push(RunSource {
                id,
                kind: family.to_string(),
                label: family.to_string(),
                lifecycle: lifecycle.clone(),
                live,
                updated_at: state
                    .get("updatedAt")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                source: Source::Worker {
                    state_path,
                    activity_path,
                    family: family.to_string(),
                },
            });
        }
    }

    let issues_root = state_dir
        .join("issues")
        .join(crate::journal::journal_key(repo_dir))
        .join("runs");
    if let Ok(entries) = std::fs::read_dir(&issues_root) {
        for entry in entries.flatten() {
            let directory = entry.path();
            let run_path = directory.join("run.json");
            let Some(state) = crate::sampling::json(&run_path) else {
                continue;
            };
            if state.get("status").and_then(Value::as_str).is_none() {
                continue;
            }
            let run_id = state
                .get("runId")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    directory
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                })
                .unwrap_or_default();
            if run_id.is_empty() {
                continue;
            }
            let id = format!("issues--{run_id}");
            let lifecycle = issue_run_lifecycle(&state);
            runs.push(RunSource {
                id,
                kind: "issues".to_string(),
                label: format!("Issues run {run_id}"),
                live: live_lifecycle(&lifecycle),
                lifecycle,
                updated_at: state
                    .get("startedAt")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                source: Source::Issues {
                    run_path,
                    activity_path: directory.join("activity.json"),
                },
            });
        }
    }

    runs.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    runs
}

/// Finds one run by its id.
pub fn find(app: &App, id: &str) -> Option<RunSource> {
    discover(app).into_iter().find(|run| run.id == id)
}

/// The absolute hypermedia link for one run's output endpoint.
pub fn output_link(app: &App, url: &Url, id: &str) -> String {
    let host = url
        .host_str()
        .map(|host| match url.port() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_string(),
        })
        .unwrap_or_else(|| app.config().hostname.clone());
    format!("ws://{host}/agent-runs/{id}/output")
}

/// One run's REST representation.
pub fn representation(app: &App, url: &Url, run: &RunSource) -> Value {
    let self_link = format!(
        "{}://{}/agent-runs/{}",
        url.scheme(),
        url.host_str()
            .map(|host| match url.port() {
                Some(port) => format!("{host}:{port}"),
                None => host.to_string(),
            })
            .unwrap_or_default(),
        run.id
    );
    json!({
        "id": run.id,
        "kind": run.kind,
        "label": run.label,
        "lifecycle": run.lifecycle,
        "live": run.live,
        "updated_at": run.updated_at,
        "self": self_link,
        "output": output_link(app, url, &run.id),
    })
}

/// One entry in a run's retained journal.
#[derive(Clone)]
struct Entry {
    cursor: u64,
    frame: Value,
}

/// The retained journal one run's sockets share.
struct RunJournal {
    entries: VecDeque<Entry>,
    next_cursor: u64,
    dropped: u64,
    last_state: Option<String>,
    last_status: Option<String>,
    last_question: Option<String>,
    last_error: Option<String>,
    activity_cursor: DetachedRunJournalCursor,
    text_cursor: DetachedRunJournalCursor,
    worker_activity: Vec<String>,
    /// When this run's state was last sampled. Every socket for the run
    /// shares the one sample, so the interval bounds the reads, never the
    /// viewers.
    last_sync: Option<Instant>,
    /// When the activity journals were last checked.
    last_activity_sync: Option<Instant>,
    /// The activity journal's last `(modified, len)`, so an idle journal is
    /// never opened at all.
    activity_stamp: Option<(SystemTime, u64)>,
    /// The detached text journal's last `(modified, len)`.
    text_stamp: Option<(SystemTime, u64)>,
    /// When this run was last sampled as live, so a sweep keeps its journal
    /// through a short grace after the run leaves the discovered set.
    last_live: Option<Instant>,
}

impl RunJournal {
    fn new() -> Self {
        Self {
            entries: VecDeque::new(),
            next_cursor: 1,
            dropped: 0,
            last_state: None,
            last_status: None,
            last_question: None,
            last_error: None,
            activity_cursor: DetachedRunJournalCursor::default(),
            text_cursor: DetachedRunJournalCursor::default(),
            worker_activity: Vec::new(),
            last_sync: None,
            last_activity_sync: None,
            activity_stamp: None,
            text_stamp: None,
            last_live: None,
        }
    }

    /// Samples the run's source when its interval is due.
    fn sync_if_due(&mut self, run: &RunSource, now: Instant, force: bool) {
        let state_due = force || elapsed(self.last_sync, now, RUN_POLL_MS);
        let activity_due = force || elapsed(self.last_activity_sync, now, RUN_ACTIVITY_MS);
        if !state_due && !activity_due {
            return;
        }
        if activity_due {
            self.last_activity_sync = Some(now);
            self.sync_activity(run);
        }
        if state_due {
            self.last_sync = Some(now);
            self.sync(run);
        }
    }

    fn push(&mut self, mut frame: Map<String, Value>, run: &str) {
        frame.insert("run".to_string(), Value::String(run.to_string()));
        frame.insert("cursor".to_string(), Value::Number(self.next_cursor.into()));
        self.next_cursor += 1;
        let cursor = self.next_cursor - 1;
        self.entries.push_back(Entry {
            cursor,
            frame: Value::Object(frame),
        });
        while self.entries.len() > RUN_OUTPUT_WINDOW {
            self.entries.pop_front();
            self.dropped += 1;
        }
    }

    /// Emits whatever the run's activity journals appended, and nothing when
    /// they did not change.
    fn sync_activity(&mut self, run: &RunSource) {
        match &run.source {
            Source::Detached(directory) => self.sync_detached_activity(run, directory),
            Source::Worker { activity_path, .. } => {
                if let Some(path) = activity_path.as_deref() {
                    self.sync_activity_file(run, path);
                }
            }
            Source::Issues { activity_path, .. } => self.sync_activity_file(run, activity_path),
        }
    }

    /// The whole sample: state, the one terminal status frame, the first
    /// error, and any activity the check had not yet seen.
    fn sync(&mut self, run: &RunSource) {
        match &run.source {
            Source::Detached(directory) => {
                let Some(state) = crate::sampling::json(&detached_run_state_path(directory)) else {
                    return;
                };
                self.emit_state(run, &state);
                self.emit_error(run, &state);
            }
            Source::Worker { state_path, .. } => {
                let Some(state) = crate::sampling::json(state_path) else {
                    return;
                };
                self.emit_state(run, &state);
                self.emit_error(run, &state);
            }
            Source::Issues { run_path, .. } => {
                let Some(state) = crate::sampling::json(run_path) else {
                    return;
                };
                self.emit_state(run, &state);
                self.emit_error(run, &state);
            }
        }
    }

    /// One `activity.json` array: read only when its stamp changed.
    fn sync_activity_file(&mut self, run: &RunSource, path: &Path) {
        let Some(stamp) = stamp_of(path) else {
            return;
        };
        if self.activity_stamp == Some(stamp) {
            return;
        }
        self.activity_stamp = Some(stamp);
        let activity = read_activity(path);
        if activity.len() < self.worker_activity.len() {
            self.worker_activity.clear();
        }
        let previous = std::mem::take(&mut self.worker_activity);
        let delta = crate::activity::activity_delta(&previous, &activity);
        self.worker_activity = activity;
        for entry in delta.entries {
            let mut frame = Map::new();
            frame.insert("type".to_string(), Value::String("activity".to_string()));
            frame.insert("text".to_string(), Value::String(entry.text));
            frame.insert("append".to_string(), Value::Bool(entry.append));
            self.push(frame, &run.id);
        }
    }

    /// The detached run's append-only journals, each checked by its stamp.
    fn sync_detached_activity(&mut self, run: &RunSource, directory: &Path) {
        let activity_path = crate::detached_run::detached_run_activity_path(directory);
        if let Some(stamp) = stamp_of(&activity_path) {
            if self.activity_stamp != Some(stamp) {
                self.activity_stamp = Some(stamp);
                let activity =
                    read_detached_run_activity_since(directory, &mut self.activity_cursor);
                for entry in activity.entries {
                    let mut frame = Map::new();
                    frame.insert("type".to_string(), Value::String("activity".to_string()));
                    frame.insert("text".to_string(), Value::String(entry.text));
                    frame.insert("append".to_string(), Value::Bool(entry.append));
                    self.push(frame, &run.id);
                }
            }
        }
        let text_path = crate::detached_run::detached_run_text_path(directory);
        if let Some(stamp) = stamp_of(&text_path) {
            if self.text_stamp != Some(stamp) {
                self.text_stamp = Some(stamp);
                let text = read_detached_run_text_since(directory, &mut self.text_cursor);
                for chunk in text.entries {
                    let mut frame = Map::new();
                    frame.insert("type".to_string(), Value::String("text".to_string()));
                    frame.insert("text".to_string(), Value::String(chunk));
                    self.push(frame, &run.id);
                }
            }
        }
    }

    fn emit_state(&mut self, run: &RunSource, state: &Value) {
        let filtered = project_state(run, state);
        let text = crate::jsjson::stringify(&filtered);
        if self.last_state.as_deref() == Some(text.as_str()) {
            return;
        }
        self.last_state = Some(text);
        // The status is the lifecycle the collection reports for this record,
        // derived from the same sampled state, so a state frame never reports
        // a non-live lifecycle without its one terminal status frame.
        let status = run.lifecycle_of(Some(state));
        if !live_lifecycle(&status) && self.last_status.as_deref() != Some(status.as_str()) {
            let mut status_frame = Map::new();
            status_frame.insert("type".to_string(), Value::String("status".to_string()));
            status_frame.insert("status".to_string(), Value::String(status.clone()));
            self.push(status_frame, &run.id);
        }
        self.last_status = Some(status);
        let mut frame = Map::new();
        frame.insert("type".to_string(), Value::String("state".to_string()));
        frame.insert("state".to_string(), filtered.clone());
        self.push(frame, &run.id);
        if let Some(question) = filtered.get("question").filter(|value| !value.is_null()) {
            let text = crate::jsjson::stringify(question);
            if self.last_question.as_deref() != Some(text.as_str()) {
                self.last_question = Some(text);
                let mut question_frame = Map::new();
                question_frame.insert("type".to_string(), Value::String("question".to_string()));
                question_frame.insert("question".to_string(), question.clone());
                self.push(question_frame, &run.id);
            }
        }
    }

    fn emit_error(&mut self, run: &RunSource, state: &Value) {
        let error = state
            .get("error")
            .or_else(|| state.get("firstStderrLine"))
            .or_else(|| state.get("turnError"))
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_string);
        if let Some(error) = error {
            if self.last_error.as_deref() != Some(error.as_str()) {
                self.last_error = Some(error.clone());
                let mut frame = Map::new();
                frame.insert("type".to_string(), Value::String("stderr".to_string()));
                frame.insert("text".to_string(), Value::String(error));
                self.push(frame, &run.id);
            }
        }
    }

    fn window_start(&self) -> u64 {
        self.dropped + 1
    }

    /// The reset marker and entries after a cursor.
    ///
    /// A cursor names an entry this journal emitted, so the journal can only
    /// continue from one it still holds: a cursor whose entries were dropped
    /// (`cursor + 1 < start`) and a cursor above every cursor this journal has
    /// emitted — one minted by another process, whose counter restarted —
    /// both resynchronize from the retained window start. The cursor
    /// immediately before the window names an entry the client already saw
    /// and missed nothing, so it keeps its plain filter; that keeps `after=0`
    /// on a fresh journal free of a reset marker.
    fn read_after(&self, after: Option<u64>) -> (Option<u64>, Vec<Value>) {
        let start = self.window_start();
        let highest = self.next_cursor - 1;
        let reset = after
            .filter(|cursor| cursor.saturating_add(1) < start || *cursor > highest)
            .map(|_| start);
        // A reset replays the retained window, so nothing before it is owed.
        let after = reset.map(|start| start - 1).or(after).unwrap_or(0);
        let entries = self
            .entries
            .iter()
            .filter(|entry| entry.cursor > after)
            .map(|entry| entry.frame.clone())
            .collect();
        (reset, entries)
    }
}

/// One projection of a run's state: the allowed keys and nothing else.
fn project_state(run: &RunSource, state: &Value) -> Value {
    let mut projected = Map::new();
    match &run.source {
        Source::Detached(_) => {
            for key in [
                "kind",
                "key",
                "status",
                "turnStatus",
                "turnError",
                "startedAt",
                "finishedAt",
                "updatedAt",
                "harnessVersion",
                "error",
                "question",
            ] {
                if let Some(value) = state.get(key) {
                    projected.insert(key.to_string(), value.clone());
                }
            }
        }
        Source::Worker { .. } => {
            // The recorded pid outranks the raw field here too, so the state
            // frame names the lifecycle the collection reports.
            projected.insert(
                "lifecycle".to_string(),
                Value::String(worker_lifecycle(state)),
            );
            for key in ["paused", "enabled", "sync", "question", "error", "notice"] {
                if let Some(value) = state.get(key) {
                    projected.insert(key.to_string(), value.clone());
                }
            }
            let cadence = json!({
                "minutes": state.get("intervalMinutes").cloned().unwrap_or(Value::Null),
                "lastRunAt": state.get("lastRunAt").cloned().unwrap_or(Value::Null),
                "nextRunAt": state.get("nextRunAt").cloned().unwrap_or(Value::Null),
            });
            projected.insert("cadence".to_string(), cadence);
            let limits = json!({
                "maxPerHour": state.get("maxPerHour").cloned().unwrap_or(Value::Null),
                "maxPending": state.get("maxPending").cloned().unwrap_or(Value::Null),
            });
            projected.insert("limits".to_string(), limits);
            if let Some(prompt) = state.get("prompt") {
                projected.insert("prompt".to_string(), prompt.clone());
            }
        }
        Source::Issues { .. } => {
            // The recorded status of an orphaned run still says `running`;
            // the projection carries the lifecycle its dead worker implies.
            projected.insert(
                "status".to_string(),
                Value::String(issue_run_lifecycle(state)),
            );
            for key in [
                "startedAt",
                "finishedAt",
                "firstStderrLine",
                "harnessVersion",
            ] {
                if let Some(value) = state.get(key) {
                    projected.insert(key.to_string(), value.clone());
                }
            }
        }
    }
    Value::Object(projected)
}

/// The journals every socket shares.
pub struct RunHub {
    journals: Mutex<HashMap<String, RunJournal>>,
}

impl Default for RunHub {
    fn default() -> Self {
        Self::new()
    }
}

impl RunHub {
    pub fn new() -> Self {
        Self {
            journals: Mutex::new(HashMap::new()),
        }
    }

    /// The retained window and entries after one cursor.
    pub fn read(&self, run: &RunSource, after: Option<u64>) -> (Option<u64>, Vec<Value>) {
        // A direct read answers the run as it stands now.
        self.read_at(run, after, Instant::now(), true)
    }

    /// The retained window and entries after one cursor, sampling the run at
    /// most once per interval. A second socket for the same run in the same
    /// interval answers what the first sample already found. A new subscriber
    /// forces one sample; the `(mtime, len)` cache still bounds the reads to
    /// one per change.
    pub fn read_at(
        &self,
        run: &RunSource,
        after: Option<u64>,
        now: Instant,
        force: bool,
    ) -> (Option<u64>, Vec<Value>) {
        let mut journals = self.journals.lock().expect("the run journal lock");
        let journal = journals
            .entry(run.id.clone())
            .or_insert_with(RunJournal::new);
        journal.sync_if_due(run, now, force);
        if run.live {
            journal.last_live = Some(now);
        }
        journal.read_after(after)
    }

    /// Drops the journal of every run `discover` no longer reports, so a
    /// process that has streamed many runs holds one journal per run it can
    /// still serve. A run still discovered keeps its window and cursors, and
    /// a run seen live within the grace keeps them through a record rewrite.
    pub fn sweep(&self, discovered: &[RunSource], now: Instant) {
        let retained: HashSet<&str> = discovered.iter().map(|run| run.id.as_str()).collect();
        let mut journals = self.journals.lock().expect("the run journal lock");
        journals.retain(|id, journal| {
            retained.contains(id.as_str())
                || journal.last_live.is_some_and(|live| {
                    now.saturating_duration_since(live)
                        < Duration::from_millis(RUN_JOURNAL_GRACE_MS)
                })
        });
    }
}

fn problem(headers: &HeaderMap, status: u16, detail: &str, extra: &[(&str, &str)]) -> Response {
    Replies::problem(headers, status, detail, extra)
}

fn path_id(path: &str) -> Option<String> {
    let rest = path.strip_prefix("/agent-runs/")?;
    let id = rest.strip_suffix("/output").unwrap_or(rest);
    if id.is_empty() || id.contains('/') {
        return None;
    }
    percent_decode(id)
}

fn percent_decode(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    let hex = |byte: u8| match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    };
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = hex(*bytes.get(index + 1)?)?;
            let low = hex(*bytes.get(index + 2)?)?;
            out.push(high * 16 + low);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn is_upgrade(headers: &HeaderMap) -> bool {
    headers
        .get(header::UPGRADE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false)
}

/// Serves the run collection, one representation, or the output endpoint.
pub async fn handle(
    server: Arc<Server>,
    request: Request,
    headers: &HeaderMap,
    url: &Url,
) -> Option<Response> {
    let path = request.uri().path().to_string();
    let method = request.method().clone();
    let app = &server.app;
    if path == "/agent-runs" {
        if method != Method::GET && method != Method::HEAD {
            return Some(problem(
                headers,
                405,
                "This path serves GET and HEAD only.",
                &[("Allow", "GET, HEAD")],
            ));
        }
        let runs: Vec<Value> = discover(app)
            .iter()
            .map(|run| representation(app, url, run))
            .collect();
        let body = json!({
            "runs": runs,
            "self": format!("{}://{}/agent-runs", url.scheme(), host_port(url)),
        });
        return Some(crate::rest::representation(
            &method,
            headers,
            200,
            body,
            &[],
        ));
    }
    let id = path_id(&path)?;
    if path.ends_with("/output") {
        if method != Method::GET {
            return Some(problem(
                headers,
                405,
                "This path serves GET only.",
                &[("Allow", "GET")],
            ));
        }
        let Some(run) = find(app, &id) else {
            return Some(problem(
                headers,
                404,
                "The requested run was not found.",
                &[],
            ));
        };
        let after = query_after(url);
        if is_upgrade(headers) {
            let hub = Arc::clone(&app.run_output);
            let app = Arc::clone(app);
            let (mut parts, _body) = request.into_parts();
            let upgraded = WebSocketUpgrade::from_request_parts(&mut parts, &()).await;
            let Ok(upgraded) = upgraded else {
                return Some(problem(
                    headers,
                    426,
                    "This endpoint upgrades to a WebSocket.",
                    &[("Upgrade", "websocket")],
                ));
            };
            return Some(
                upgraded.on_upgrade(move |socket| run_socket(hub, app, run, after, socket)),
            );
        }
        let (reset, entries) = app.run_output.read(&run, after);
        let mut frames = Vec::new();
        if let Some(cursor) = reset {
            frames.push(json!({"type": "reset", "run": run.id, "cursor": cursor}));
        }
        frames.extend(entries);
        let body = json!({"frames": frames});
        return Some(crate::rest::representation(
            &method,
            headers,
            200,
            body,
            &[],
        ));
    }
    if method != Method::GET && method != Method::HEAD {
        return Some(problem(
            headers,
            405,
            "This path serves GET and HEAD only.",
            &[("Allow", "GET, HEAD")],
        ));
    }
    let Some(run) = find(app, &id) else {
        return Some(problem(
            headers,
            404,
            "The requested run was not found.",
            &[],
        ));
    };
    let body = representation(app, url, &run);
    Some(crate::rest::representation(
        &method,
        headers,
        200,
        body,
        &[],
    ))
}

fn host_port(url: &Url) -> String {
    url.host_str()
        .map(|host| match url.port() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_string(),
        })
        .unwrap_or_default()
}

fn query_after(url: &Url) -> Option<u64> {
    url.query_pairs()
        .find(|(name, _)| name == "after")
        .and_then(|(_, value)| value.parse().ok())
}

async fn run_socket(
    hub: Arc<RunHub>,
    app: Arc<App>,
    mut run: RunSource,
    after: Option<u64>,
    mut socket: WebSocket,
) {
    use futures_util::{SinkExt, StreamExt};
    let mut sent = after;
    let mut fresh = true;
    // The socket tick is the activity check's cadence; the run's state is
    // sampled once per `RUN_POLL_MS` however many sockets are open.
    let mut interval = tokio::time::interval(Duration::from_millis(RUN_ACTIVITY_MS));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = interval.tick() => {
                let state = run.state();
                run.lifecycle = run.lifecycle_of(state.as_deref());
                run.live = run.live_of(state.as_deref());
                // A run that just stopped owes its terminal status frame, so
                // that tick samples the journal regardless of its interval;
                // the close follows the frames the sample pushed.
                let (reset, entries) =
                    hub.read_at(&run, sent, Instant::now(), fresh || !run.live);
                fresh = false;
                if let Some(cursor) = reset {
                    if send_frame(&mut socket, &json!({"type": "reset", "run": run.id, "cursor": cursor})).await.is_err() {
                        break;
                    }
                    // The reset replays from the window start, so this socket
                    // now owes nothing before it; a later push continues from
                    // the cursor just before the window.
                    sent = Some(cursor.saturating_sub(1));
                }
                let mut last = sent;
                for frame in entries {
                    if let Some(cursor) = frame.get("cursor").and_then(Value::as_u64) {
                        last = Some(cursor);
                    }
                    if send_frame(&mut socket, &frame).await.is_err() {
                        return;
                    }
                }
                sent = last;
                if !run.live {
                    let _ = socket.close().await;
                    break;
                }
            }
            incoming = socket.next() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(_)) => {}
                }
            }
        }
    }
    let _ = app;
}

async fn send_frame(socket: &mut WebSocket, frame: &Value) -> Result<(), ()> {
    socket
        .send(Message::Text(crate::jsjson::stringify(frame).into()))
        .await
        .map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A run whose source is absent, so a read creates its journal without
    /// producing a frame.
    fn run_source(id: &str, live: bool) -> RunSource {
        RunSource {
            id: id.to_string(),
            kind: "worker".to_string(),
            label: id.to_string(),
            lifecycle: "running".to_string(),
            live,
            updated_at: None,
            source: Source::Worker {
                state_path: PathBuf::from("absent").join(format!("{id}.json")),
                activity_path: None,
                family: "worker".to_string(),
            },
        }
    }

    /// A fresh scratch root beside the crate, removed before each use.
    fn scratch(label: &str) -> PathBuf {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!("runs-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("a scratch directory");
        root
    }

    fn dashboard(state_dir: &Path, repo_dir: &Path) -> Arc<App> {
        App::new(
            crate::config::Config {
                hostname: "127.0.0.1".to_string(),
                port: 0,
                adrs_dir: repo_dir.join("adrs"),
                repo_dir: repo_dir.to_path_buf(),
                goal_file: repo_dir.join("GOAL.md"),
                static_dir: None,
                agent_command: "omp acp".to_string(),
                state_dir: state_dir.to_path_buf(),
                allowed_hosts: Vec::new(),
                feedback: None,
            },
            crate::journal::Journal::open(state_dir, repo_dir, 0),
        )
    }

    fn write_json(path: &Path, value: &Value) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("a record directory");
        }
        std::fs::write(path, serde_json::to_string(value).expect("record JSON"))
            .expect("a record file");
    }

    /// The activity lines one worker run's socket frames carry.
    fn streamed_activity(run: &RunSource) -> Vec<String> {
        let hub = RunHub::new();
        let (_, frames) = hub.read(run, None);
        frames
            .iter()
            .filter(|frame| frame["type"] == "activity")
            .filter_map(|frame| frame["text"].as_str().map(str::to_string))
            .collect()
    }

    #[tokio::test]
    async fn a_scout_run_streams_the_activity_of_the_scan_its_state_names() {
        let root = scratch("scout-activity");
        let repo_dir = root.join("repo");
        let state_dir = root.join("state");
        let scan_id = "2026-11-10T12-00-00-000Z";
        let activity = repo_dir
            .join(".devboard")
            .join(".tmp")
            .join("scout")
            .join("scans")
            .join(scan_id)
            .join("activity.json");
        if let Some(parent) = activity.parent() {
            std::fs::create_dir_all(parent).expect("a scan directory");
        }
        std::fs::write(&activity, "[\"scanning the backlog\"]\n").expect("an activity file");
        write_json(
            &state_dir
                .join("scout")
                .join(crate::journal::journal_key(&repo_dir))
                .join("state.json"),
            &json!({
                "version": 4,
                "lifecycle": "idle",
                "newestScanId": scan_id,
                "updatedAt": "2026-11-10T12:00:01.000Z"
            }),
        );
        let app = dashboard(&state_dir, &repo_dir);
        let runs = discover(&app);
        let run = runs
            .iter()
            .find(|run| run.kind == "scout")
            .expect("one Scout run");
        let Source::Worker { activity_path, .. } = &run.source else {
            panic!("a Scout run is a worker run");
        };
        assert_eq!(activity_path.as_deref(), Some(activity.as_path()));
        assert_eq!(streamed_activity(run), ["scanning the backlog"]);
    }

    #[tokio::test]
    async fn a_release_train_run_streams_the_activity_of_the_run_it_names() {
        let root = scratch("release-train-activity");
        let repo_dir = root.join("repo");
        let state_dir = root.join("state");
        let release_train = state_dir.join("release-train");
        let run_id = "1794312995279-f83edbe0";
        let activity = release_train
            .join("runs")
            .join(run_id)
            .join("activity.json");
        if let Some(parent) = activity.parent() {
            std::fs::create_dir_all(parent).expect("a run directory");
        }
        std::fs::write(&activity, "[\"releasing 1.45.1\"]\n").expect("an activity file");
        write_json(
            &release_train
                .join("workers")
                .join("1.45.0")
                .join("worker.json"),
            &json!({
                "version": 1,
                "pid": std::process::id(),
                "root": repo_dir.to_string_lossy(),
                "stateDir": state_dir.to_string_lossy(),
                "lifecycle": "running",
                "activeRun": run_id,
                "updatedAt": "2026-11-10T12:16:35.350Z"
            }),
        );
        let app = dashboard(&state_dir, &repo_dir);
        let runs = discover(&app);
        let run = runs
            .iter()
            .find(|run| run.kind == "release-train")
            .expect("one Release Train run");
        assert_eq!(run.id, "release-train--1.45.0");
        let Source::Worker { activity_path, .. } = &run.source else {
            panic!("a Release Train run is a worker run");
        };
        assert_eq!(activity_path.as_deref(), Some(activity.as_path()));
        assert_eq!(streamed_activity(run), ["releasing 1.45.1"]);
    }

    #[test]
    fn a_reset_names_the_retained_window_start() {
        let mut journal = RunJournal::new();
        for index in 0..(RUN_OUTPUT_WINDOW + 2) {
            let mut frame = Map::new();
            frame.insert("type".to_string(), Value::String("activity".to_string()));
            frame.insert("text".to_string(), Value::String(format!("line {index}")));
            journal.push(frame, "run-a");
        }
        let (reset, entries) = journal.read_after(Some(1));
        assert_eq!(reset, Some(3));
        assert_eq!(entries.len(), RUN_OUTPUT_WINDOW);
        assert_eq!(entries[0]["cursor"], serde_json::json!(3));
    }

    #[test]
    fn a_cursor_above_the_highest_cursor_resynchronizes() {
        let mut journal = RunJournal::new();
        for index in 0..2 {
            let mut frame = Map::new();
            frame.insert("type".to_string(), Value::String("activity".to_string()));
            frame.insert("text".to_string(), Value::String(format!("line {index}")));
            journal.push(frame, "run-a");
        }
        // A cursor minted by another process lies above every cursor this
        // journal will emit, so it names no gap-free continuation.
        let (reset, entries) = journal.read_after(Some(9));
        assert_eq!(reset, Some(1));
        let cursors: Vec<Value> = entries
            .iter()
            .map(|entry| entry["cursor"].clone())
            .collect();
        assert_eq!(cursors, vec![serde_json::json!(1), serde_json::json!(2)]);
    }

    #[test]
    fn a_cursor_above_the_highest_cursor_resynchronizes_an_empty_journal() {
        let journal = RunJournal::new();
        let (reset, entries) = journal.read_after(Some(4));
        assert_eq!(reset, Some(1));
        assert!(entries.is_empty());
    }

    #[test]
    fn a_cursor_inside_the_window_answers_only_later_entries() {
        let mut journal = RunJournal::new();
        for index in 0..3 {
            let mut frame = Map::new();
            frame.insert("type".to_string(), Value::String("activity".to_string()));
            frame.insert("text".to_string(), Value::String(format!("line {index}")));
            journal.push(frame, "run-a");
        }
        let (reset, entries) = journal.read_after(Some(2));
        assert_eq!(reset, None);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["cursor"], serde_json::json!(3));
    }

    #[test]
    fn a_fresh_journal_answers_no_reset_for_cursor_zero() {
        let mut journal = RunJournal::new();
        let (reset, entries) = journal.read_after(Some(0));
        assert_eq!(reset, None);
        assert!(entries.is_empty());
        let mut frame = Map::new();
        frame.insert("type".to_string(), Value::String("activity".to_string()));
        journal.push(frame, "run-a");
        let (reset, entries) = journal.read_after(Some(0));
        assert_eq!(reset, None);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["cursor"], serde_json::json!(1));
    }

    #[test]
    fn a_sweep_keeps_only_the_journals_of_discovered_runs() {
        let hub = RunHub::new();
        let kept = run_source("run-kept", false);
        let dropped = run_source("run-dropped", false);
        let now = Instant::now();
        hub.read_at(&kept, None, now, true);
        hub.read_at(&dropped, None, now, true);
        {
            let mut journals = hub.journals.lock().expect("the run journal lock");
            let journal = journals.get_mut(&kept.id).expect("the kept journal");
            for index in 0..(RUN_OUTPUT_WINDOW + 2) {
                let mut frame = Map::new();
                frame.insert("type".to_string(), Value::String("activity".to_string()));
                frame.insert("text".to_string(), Value::String(format!("line {index}")));
                journal.push(frame, &kept.id);
            }
        }
        hub.sweep(std::slice::from_ref(&kept), now);
        {
            let journals = hub.journals.lock().expect("the run journal lock");
            assert_eq!(journals.len(), 1);
            assert!(journals.contains_key(&kept.id));
        }
        let (reset, entries) = hub.read_at(&kept, Some(1), now, true);
        assert_eq!(reset, Some(3));
        assert_eq!(entries.len(), RUN_OUTPUT_WINDOW);
        hub.sweep(&[], now);
        assert!(hub
            .journals
            .lock()
            .expect("the run journal lock")
            .is_empty());
    }

    #[test]
    fn a_sweep_keeps_a_recently_live_journal_through_its_grace() {
        let hub = RunHub::new();
        let run = run_source("run-live", true);
        let now = Instant::now();
        hub.read_at(&run, None, now, true);
        hub.sweep(&[], now + Duration::from_secs(1));
        assert_eq!(hub.journals.lock().expect("the run journal lock").len(), 1);
        hub.sweep(&[], now + Duration::from_millis(RUN_JOURNAL_GRACE_MS));
        assert!(hub
            .journals
            .lock()
            .expect("the run journal lock")
            .is_empty());
    }

    #[test]
    fn the_collection_lists_exactly_the_families_the_worker_accepts() {
        let mut families: Vec<&str> = FAMILIES.to_vec();
        families.sort_unstable();
        families.dedup();
        assert_eq!(
            families.len(),
            FAMILIES.len(),
            "a family is listed once: {FAMILIES:?}"
        );
        for family in FAMILIES {
            assert!(
                crate::workers::known_family(family),
                "{family} is a family the worker command accepts"
            );
        }
        assert!(
            !crate::workers::known_family("api-standard"),
            "a name nothing writes is neither accepted nor collected"
        );
    }

    #[test]
    fn the_watchdog_worker_states_are_read_from_its_own_layout() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!("runs-family-{}", std::process::id()));
        let repo = root.join("repo");
        let state_dir = root.join("state");
        let directory = watchdog::watchdog_directory(&repo);
        std::fs::create_dir_all(directory.join("workers/1.45.0")).expect("a version directory");
        std::fs::write(directory.join("worker.json"), "{}").expect("the legacy record");
        std::fs::write(directory.join("workers/1.45.0/worker.json"), "{}")
            .expect("the versioned record");

        let states = family_worker_states(&state_dir, &repo, "watchdog");
        assert_eq!(
            states,
            vec![
                ("legacy".to_string(), directory.join("worker.json")),
                (
                    "1.45.0".to_string(),
                    directory.join("workers/1.45.0/worker.json"),
                ),
            ],
            "the watchdog publishes beside the repository, not under the state directory"
        );

        // The repository-scoped families keep their own `state.json` layout.
        let scout = state_dir
            .join("scout")
            .join(crate::journal::journal_key(&repo));
        std::fs::create_dir_all(scout.join("workers/1.45.0")).expect("a version directory");
        std::fs::write(scout.join("state.json"), "{}").expect("the repository state");
        std::fs::write(scout.join("workers/1.45.0/state.json"), "{}").expect("the versioned state");
        let states = family_worker_states(&state_dir, &repo, "scout");
        assert_eq!(states.len(), 2);
        assert_eq!(states[1].0, "1.45.0");

        std::fs::remove_dir_all(&root).expect("the scratch tree is removed");
    }
}
