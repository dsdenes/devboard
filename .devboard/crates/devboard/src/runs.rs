//! One output socket per live ACP run.
//!
//! Every run keeps a retained journal of its state, question, activity,
//! assistant text, diagnostics, and terminal status. A socket replays that
//! journal from a cursor and then follows it live. No frame carries another
//! run's identity or any workspace state.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

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

/// The retained window of one run's output journal.
pub const RUN_OUTPUT_WINDOW: usize = 1000;
/// How often one socket reads its run's journals.
const RUN_POLL_MS: u64 = 100;
/// The family directories a worker run can live under.
const FAMILIES: [&str; 9] = [
    "scout",
    "design",
    "dead-code",
    "mcp-optimizer",
    "api-standard",
    "api-standards",
    "single-responsibility",
    "consistent-naming",
    "release-train",
];

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
    pub fn state(&self) -> Option<Value> {
        match &self.source {
            Source::Detached(directory) => {
                let state = read_detached_run_state(directory)?;
                Some(state.to_json())
            }
            Source::Worker { state_path, .. } => read_json(state_path),
            Source::Issues { run_path, .. } => read_json(run_path),
        }
    }

    /// The run's lifecycle string, read from its state.
    pub fn current_lifecycle(&self) -> String {
        let Some(state) = self.state() else {
            return "stopped".to_string();
        };
        match &self.source {
            Source::Detached(_) => state
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("stopped")
                .to_string(),
            Source::Worker { .. } => worker_lifecycle(&state),
            Source::Issues { .. } => state
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("stopped")
                .to_string(),
        }
    }

    /// True while the run may still produce output.
    pub fn current_live(&self) -> bool {
        match &self.source {
            Source::Worker { .. } => self
                .state()
                .map(|state| worker_run_live(&state))
                .unwrap_or(false),
            _ => live_lifecycle(&self.current_lifecycle()),
        }
    }
}

fn live_lifecycle(lifecycle: &str) -> bool {
    !matches!(
        lifecycle,
        "stopped" | "failed" | "succeeded" | "idle" | "done"
    )
}

/// A family worker is live while its recorded pid is alive; between cycles
/// its lifecycle is `idle` but the worker still serves the family.
fn worker_run_live(state: &Value) -> bool {
    if let Some(pid) = state
        .get("worker")
        .and_then(|worker| worker.get("pid"))
        .and_then(Value::as_u64)
    {
        if (1..=u32::MAX as u64).contains(&pid) {
            return crate::supervision::live_process(pid as u32);
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
        _ if state.get("draining") == Some(&Value::Bool(true)) => "stopping".to_string(),
        _ => "running".to_string(),
    }
}

fn read_json(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn read_activity(path: &Path) -> Vec<String> {
    read_json(path)
        .and_then(|value| value.as_array().cloned())
        .map(|entries| {
            entries
                .into_iter()
                .filter_map(|entry| entry.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn worker_activity_path(repo_dir: &Path, family: &str, state: &Value) -> Option<PathBuf> {
    let cycle = state
        .get("newestCycleId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            state
                .get("activeCycleId")
                .and_then(Value::as_str)
                .map(str::to_string)
        })?;
    let directory = if family == "scout" { "scans" } else { "cycles" };
    Some(
        repo_dir
            .join(".devboard")
            .join(".tmp")
            .join(family)
            .join(directory)
            .join(cycle)
            .join("activity.json"),
    )
}

/// Every run this dashboard can see, newest state first.
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
        let root = state_dir
            .join(family)
            .join(crate::journal::journal_key(repo_dir));
        let mut state_paths = Vec::new();
        if root.join("state.json").is_file() {
            state_paths.push(root.join("state.json"));
        }
        if let Ok(entries) = std::fs::read_dir(root.join("workers")) {
            for entry in entries.flatten() {
                let path = entry.path().join("state.json");
                if path.is_file() {
                    state_paths.push(path);
                }
            }
        }
        for state_path in state_paths {
            let Some(state) = read_json(&state_path) else {
                continue;
            };
            if state.get("lifecycle").and_then(Value::as_str).is_none() {
                continue;
            }
            let lifecycle = worker_lifecycle(&state);
            let version = state_path
                .parent()
                .and_then(Path::file_name)
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "legacy".to_string());
            let id = format!("{family}--{version}");
            let activity_path = worker_activity_path(repo_dir, family, &state);
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
            let Some(state) = read_json(&run_path) else {
                continue;
            };
            let Some(status) = state.get("status").and_then(Value::as_str) else {
                continue;
            };
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
            runs.push(RunSource {
                id,
                kind: "issues".to_string(),
                label: format!("Issues run {run_id}"),
                lifecycle: status.to_string(),
                live: live_lifecycle(status),
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

    fn sync(&mut self, run: &RunSource) {
        match &run.source {
            Source::Detached(directory) => self.sync_detached(run, directory),
            Source::Worker {
                state_path,
                activity_path,
                ..
            } => self.sync_worker(run, state_path, activity_path.as_deref()),
            Source::Issues {
                run_path,
                activity_path,
            } => self.sync_issues(run, run_path, activity_path),
        }
    }

    fn emit_state(&mut self, run: &RunSource, state: &Value, cursor_key: &str) {
        let filtered = project_state(run, state);
        let text = crate::jsjson::stringify(&filtered);
        if self.last_state.as_deref() == Some(text.as_str()) {
            return;
        }
        self.last_state = Some(text);
        let status = run
            .state()
            .and_then(|value| {
                value
                    .get(cursor_key)
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| run.current_lifecycle());
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

    fn sync_detached(&mut self, run: &RunSource, directory: &Path) {
        let Some(state) = read_json(&detached_run_state_path(directory)) else {
            return;
        };
        let activity = read_detached_run_activity_since(directory, &mut self.activity_cursor);
        for entry in activity.entries {
            let mut frame = Map::new();
            frame.insert("type".to_string(), Value::String("activity".to_string()));
            frame.insert("text".to_string(), Value::String(entry.text));
            frame.insert("append".to_string(), Value::Bool(entry.append));
            self.push(frame, &run.id);
        }
        let text = read_detached_run_text_since(directory, &mut self.text_cursor);
        for chunk in text.entries {
            let mut frame = Map::new();
            frame.insert("type".to_string(), Value::String("text".to_string()));
            frame.insert("text".to_string(), Value::String(chunk));
            self.push(frame, &run.id);
        }
        self.emit_state(run, &state, "status");
        self.emit_error(run, &state);
    }

    fn sync_worker(&mut self, run: &RunSource, state_path: &Path, activity_path: Option<&Path>) {
        let Some(state) = read_json(state_path) else {
            return;
        };
        let Some(activity_path) = activity_path else {
            self.emit_state(run, &state, "lifecycle");
            self.emit_error(run, &state);
            return;
        };
        let activity = read_activity(activity_path);
        if activity.len() < self.worker_activity.len() {
            self.worker_activity.clear();
        }
        let previous = self.worker_activity.clone();
        let delta = crate::activity::activity_delta(&previous, &activity);
        self.worker_activity = activity;
        for entry in delta.entries {
            let mut frame = Map::new();
            frame.insert("type".to_string(), Value::String("activity".to_string()));
            frame.insert("text".to_string(), Value::String(entry.text));
            frame.insert("append".to_string(), Value::Bool(entry.append));
            self.push(frame, &run.id);
        }
        if delta.replay && !previous.is_empty() {
            // A rewritten log replays from its start; the retained window
            // keeps the ordering monotonic without duplicating a prefix.
        }
        self.emit_state(run, &state, "lifecycle");
        self.emit_error(run, &state);
    }

    fn sync_issues(&mut self, run: &RunSource, run_path: &Path, activity_path: &Path) {
        let Some(state) = read_json(run_path) else {
            return;
        };
        let activity = read_activity(activity_path);
        if activity.len() < self.worker_activity.len() {
            self.worker_activity.clear();
        }
        let previous = self.worker_activity.clone();
        let delta = crate::activity::activity_delta(&previous, &activity);
        self.worker_activity = activity;
        for entry in delta.entries {
            let mut frame = Map::new();
            frame.insert("type".to_string(), Value::String("activity".to_string()));
            frame.insert("text".to_string(), Value::String(entry.text));
            frame.insert("append".to_string(), Value::Bool(entry.append));
            self.push(frame, &run.id);
        }
        self.emit_state(run, &state, "status");
        self.emit_error(run, &state);
    }

    fn window_start(&self) -> u64 {
        self.dropped + 1
    }

    /// The reset marker and entries after a cursor.
    fn read_after(&self, after: Option<u64>) -> (Option<u64>, Vec<Value>) {
        let start = self.window_start();
        let reset = after.filter(|cursor| *cursor < start).map(|_| start);
        let after = after.unwrap_or(0);
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
            projected.insert(
                "lifecycle".to_string(),
                state
                    .get("lifecycle")
                    .cloned()
                    .unwrap_or_else(|| Value::String("stopped".to_string())),
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
            projected.insert(
                "status".to_string(),
                state
                    .get("status")
                    .cloned()
                    .unwrap_or_else(|| Value::String("stopped".to_string())),
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
        let mut journals = self.journals.lock().expect("the run journal lock");
        let journal = journals
            .entry(run.id.clone())
            .or_insert_with(RunJournal::new);
        journal.sync(run);
        journal.read_after(after)
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
    let mut interval = tokio::time::interval(Duration::from_millis(RUN_POLL_MS));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = interval.tick() => {
                run.lifecycle = run.current_lifecycle();
                run.live = run.current_live();
                let (reset, entries) = hub.read(&run, sent);
                if let Some(cursor) = reset {
                    if send_frame(&mut socket, &json!({"type": "reset", "run": run.id, "cursor": cursor})).await.is_err() {
                        break;
                    }
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
}
