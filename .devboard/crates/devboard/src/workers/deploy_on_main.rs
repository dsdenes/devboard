//! The push-triggered Deploy on main family.
//!
//! No cadence and no timer: the served checkout's `main` is the trigger. One
//! worker owns the root's deploy lock, watches the branch, and starts at most
//! one run at a time. Two advances while a run is live coalesce into one
//! pending run at the newest tip. A run fast-forwards `.worktree/deploy-main`
//! to the triggering commit and hands one `omp acp` peer the host project's
//! `AGENTS.md` deploy instructions, executed from that worktree.
//!
//! The served checkout is never edited: the worker only adds `/.worktree/` to
//! its `.git/info/exclude`, moves no ref, and never touches the dashboard.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Command;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::{json, Value};

use super::release_train::{
    acquire_lock, iso_from_millis, live_lock_owners, now_millis, worker_version_key,
    write_json_atomic, AcquiredLock, AgentLifecycle, Clock, LockAcquisition, LockDetails,
    LockOwner, LogFn,
};
use super::worktrees::DEPLOY_WORKTREE_NAME;
use super::WorkerInvocation;

pub const DEPLOY_DIRECTORY: &str = "deploy-on-main";
pub const STATE_VERSION: i64 = 1;
pub const RUN_VERSION: i64 = 1;
pub const WORKER_VERSION: i64 = 1;
pub const RUN_HISTORY_LIMIT: usize = 20;
pub const ACTIVITY_MAX_ENTRIES: usize = 200;
/// How often the worker reads its control directory while it waits for a ref
/// change. This starts nothing: the ref event is the only trigger.
pub const CONTROL_POLL_MS: u64 = 250;
const RUNS_DIRECTORY: &str = "runs";
const WORKERS_DIRECTORY: &str = "workers";
const EXCLUDE_LINE: &str = "/.worktree/";

/* ------------------------------------------------------------------------ */
/* Paths                                                                     */
/* ------------------------------------------------------------------------ */

/// `<state-dir>/deploy-on-main`.
pub fn deploy_directory(state_dir: &Path) -> PathBuf {
    state_dir.join(DEPLOY_DIRECTORY)
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

/// Every version's worker directory under one deploy directory.
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

pub fn runs_directory(directory: &Path) -> PathBuf {
    directory.join(RUNS_DIRECTORY)
}

pub fn run_directory(directory: &Path, id: &str) -> PathBuf {
    runs_directory(directory).join(id)
}

pub fn request_path(directory: &Path, id: &str) -> PathBuf {
    run_directory(directory, id).join("request.json")
}

pub fn activity_path(directory: &Path, id: &str) -> PathBuf {
    run_directory(directory, id).join("activity.json")
}

pub fn result_path(directory: &Path, id: &str) -> PathBuf {
    run_directory(directory, id).join("result.json")
}

/// The activity file of the run the worker record names as active.
pub fn state_activity_path(directory: &Path, state: &Value) -> Option<PathBuf> {
    let id = state.get("activeRun").and_then(Value::as_str)?;
    Some(activity_path(directory, id))
}

/// `<repo root>/.worktree/deploy-main`.
pub fn deploy_worktree_path(repo_dir: &Path) -> PathBuf {
    repo_dir.join(".worktree").join(DEPLOY_WORKTREE_NAME)
}

/* ------------------------------------------------------------------------ */
/* Git                                                                       */
/* ------------------------------------------------------------------------ */

fn git(repo_dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|error| format!("git {} failed to start: {error}", args.join(" ")))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            detail
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// The served checkout's `main` tip.
pub fn main_commit(repo_dir: &Path) -> Option<String> {
    git(
        repo_dir,
        &["rev-parse", "--verify", "refs/heads/main^{commit}"],
    )
    .ok()
    .filter(|text| !text.is_empty())
}

fn git_dir(repo_dir: &Path) -> Option<PathBuf> {
    let text = git(repo_dir, &["rev-parse", "--absolute-git-dir"]).ok()?;
    (!text.is_empty()).then(|| PathBuf::from(text))
}

fn common_git_dir(repo_dir: &Path) -> Option<PathBuf> {
    let text = git(repo_dir, &["rev-parse", "--git-common-dir"]).ok()?;
    if text.is_empty() {
        return git_dir(repo_dir);
    }
    let path = PathBuf::from(&text);
    if path.is_absolute() {
        Some(path)
    } else {
        Some(repo_dir.join(path))
    }
}

/// Adds `/.worktree/` to the served checkout's private exclude file once, so
/// an untracked deploy worktree never appears in `git status --porcelain`.
/// The tracked tree and every tracked file stay byte-identical.
pub fn ensure_worktree_excluded(repo_dir: &Path) -> Result<(), String> {
    let Some(directory) = common_git_dir(repo_dir) else {
        return Err("the checkout has no git directory".to_string());
    };
    let info = directory.join("info");
    std::fs::create_dir_all(&info).map_err(|error| format!("{}: {error}", info.display()))?;
    let exclude = info.join("exclude");
    let current = std::fs::read_to_string(&exclude).unwrap_or_default();
    if current.lines().any(|line| line.trim() == EXCLUDE_LINE) {
        return Ok(());
    }
    let mut next = current;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(EXCLUDE_LINE);
    next.push('\n');
    std::fs::write(&exclude, next).map_err(|error| format!("{}: {error}", exclude.display()))
}

/// Fast-forwards the deploy worktree to `commit`, creating it when absent.
///
/// Only a descendant moves it. Any other commit settles the run as failed
/// before a peer starts: the worktree's HEAD is the deploy's whole history, and
/// rewriting it would deploy an unreviewed tree over the last one.
pub fn fast_forward_worktree(repo_dir: &Path, worktree: &Path, commit: &str) -> Result<(), String> {
    ensure_worktree_excluded(repo_dir)?;
    let registered = worktree.join(".git").exists();
    if !registered {
        if let Some(parent) = worktree.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("{}: {error}", parent.display()))?;
        }
        let when = worktree.to_string_lossy().into_owned();
        match git(repo_dir, &["worktree", "add", "--detach", &when, commit]) {
            Ok(_) => return Ok(()),
            Err(first) => {
                // A stale registration or a half-removed directory is not a
                // deploy failure: prune once and retry.
                let _ = git(repo_dir, &["worktree", "prune"]);
                if worktree.exists() {
                    std::fs::remove_dir_all(worktree)
                        .map_err(|error| format!("{}: {error}", worktree.display()))?;
                }
                git(repo_dir, &["worktree", "add", "--detach", &when, commit])
                    .map(|_| ())
                    .map_err(|second| {
                        format!(
                            "the deploy worktree could not be created at {when}: {first}; {second}"
                        )
                    })?;
                return Ok(());
            }
        }
    }
    let head = git(worktree, &["rev-parse", "HEAD"])?;
    if head == commit {
        return Ok(());
    }
    let ancestor = Command::new("git")
        .arg("-C")
        .arg(worktree)
        .args(["merge-base", "--is-ancestor", &head, commit])
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    if !ancestor {
        return Err(format!(
            "the triggering commit {commit} is not a descendant of the deploy worktree's HEAD {head}; \
             the worktree was not moved and nothing was deployed"
        ));
    }
    let status = git(worktree, &["status", "--porcelain"])?;
    if !status.trim().is_empty() {
        return Err(format!(
            "the deploy worktree at {} has uncommitted changes; refusing to fast-forward it",
            worktree.display()
        ));
    }
    git(worktree, &["merge", "--ff-only", commit]).map_err(|error| {
        format!("the deploy worktree could not fast-forward to {commit}: {error}")
    })?;
    let head = git(worktree, &["rev-parse", "HEAD"])?;
    if head != commit {
        return Err(format!(
            "the deploy worktree's HEAD is {head}, not the triggering commit {commit}"
        ));
    }
    Ok(())
}

/// One Markdown heading: its level and its trimmed title.
fn heading(line: &str) -> Option<(usize, &str)> {
    let trimmed = line.trim_start();
    let hashes = trimmed
        .chars()
        .take_while(|character| *character == '#')
        .count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = trimmed[hashes..].strip_prefix(' ')?;
    Some((hashes, rest.trim()))
}

/// The deploy-instructions section of one `AGENTS.md`, or `None` when the
/// document carries none.
///
/// A heading that names a deploy is the section's start; the section ends at
/// the next heading of the same or a higher level. The body is what the peer
/// receives, so the instructions never depend on the peer guessing which
/// paragraph the worker meant.
pub fn deploy_instructions(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.iter().position(|line| {
        heading(line)
            .map(|(_, title)| title.to_ascii_lowercase().contains("deploy"))
            .unwrap_or(false)
    })?;
    let level = heading(lines[start]).map(|(level, _)| level).unwrap_or(1);
    let mut body: Vec<&str> = Vec::new();
    for line in &lines[start + 1..] {
        if let Some((next, _)) = heading(line) {
            if next <= level {
                break;
            }
        }
        body.push(line);
    }
    let section = body.join("\n").trim().to_string();
    (!section.is_empty()).then_some(section)
}

/* ------------------------------------------------------------------------ */
/* State                                                                     */
/* ------------------------------------------------------------------------ */

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeployRunState {
    Running,
    Succeeded,
    Failed,
    Skipped,
    Stopped,
}

impl DeployRunState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
            Self::Stopped => "stopped",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "running" => Self::Running,
            "succeeded" => Self::Succeeded,
            "failed" => Self::Failed,
            "skipped" => Self::Skipped,
            "stopped" => Self::Stopped,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeployPeer {
    pub command: String,
    pub pid: u32,
    pub argv: Vec<String>,
    pub started_at: String,
}

impl DeployPeer {
    fn to_json(&self) -> Value {
        json!({
            "command": self.command,
            "pid": self.pid,
            "argv": self.argv,
            "startedAt": self.started_at,
        })
    }

    fn parse(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        Some(Self {
            command: object.get("command")?.as_str()?.to_string(),
            pid: u32::try_from(object.get("pid")?.as_u64()?).ok()?,
            argv: object
                .get("argv")?
                .as_array()?
                .iter()
                .filter_map(|entry| entry.as_str().map(str::to_string))
                .collect(),
            started_at: object.get("startedAt")?.as_str()?.to_string(),
        })
    }
}

/// One deploy run: the triggering commit, the worktree it deployed from, and
/// the outcome. Exactly one of these is appended per advance of `main`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeployRun {
    pub id: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub state: DeployRunState,
    pub commit: String,
    pub worktree: String,
    pub detail: Option<String>,
    pub peer: Option<DeployPeer>,
}

impl DeployRun {
    fn to_json(&self) -> Value {
        json!({
            "version": RUN_VERSION,
            "id": self.id,
            "startedAt": self.started_at,
            "endedAt": self.ended_at,
            "state": self.state.as_str(),
            "commit": self.commit,
            "worktree": self.worktree,
            "detail": self.detail,
            "peer": self.peer.as_ref().map(DeployPeer::to_json),
        })
    }

    fn parse(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        if object.get("version").and_then(Value::as_u64) != Some(RUN_VERSION as u64) {
            return None;
        }
        let text = |key: &str| object.get(key).and_then(Value::as_str).map(str::to_string);
        Some(Self {
            id: text("id")?,
            started_at: text("startedAt"),
            ended_at: text("endedAt"),
            state: DeployRunState::parse(object.get("state")?.as_str()?)?,
            commit: text("commit")?,
            worktree: text("worktree")?,
            detail: text("detail"),
            peer: object.get("peer").and_then(DeployPeer::parse),
        })
    }
}

#[derive(Clone, Debug)]
pub struct DeployState {
    pub repo: String,
    pub root: String,
    pub updated_at: String,
    pub activity: Vec<String>,
    pub runs: Vec<DeployRun>,
    pub issues: Vec<Value>,
    /// Commits whose failed run already filed its one issue.
    pub issued_commits: Vec<String>,
    /// The newest commit a run was started for or the start baseline.
    pub last_commit: Option<String>,
}

impl DeployState {
    pub fn empty(repo: &str, root: &str, now_ms: i64) -> Self {
        Self {
            repo: repo.to_string(),
            root: root.to_string(),
            updated_at: iso_from_millis(now_ms),
            activity: Vec::new(),
            runs: Vec::new(),
            issues: Vec::new(),
            issued_commits: Vec::new(),
            last_commit: None,
        }
    }

    fn to_json(&self) -> Value {
        json!({
            "version": STATE_VERSION,
            "repo": self.repo,
            "root": self.root,
            "updatedAt": self.updated_at,
            "activity": self.activity,
            "runs": self.runs.iter().map(DeployRun::to_json).collect::<Vec<Value>>(),
            "issues": self.issues,
            "issuedCommits": self.issued_commits,
            "lastCommit": self.last_commit,
        })
    }

    fn parse(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        if object.get("version").and_then(Value::as_u64) != Some(STATE_VERSION as u64) {
            return None;
        }
        let text = |key: &str| object.get(key).and_then(Value::as_str).map(str::to_string);
        let list = |key: &str| {
            object
                .get(key)
                .and_then(Value::as_array)
                .map(|entries| {
                    entries
                        .iter()
                        .filter_map(|entry| entry.as_str().map(str::to_string))
                        .collect::<Vec<String>>()
                })
                .unwrap_or_default()
        };
        Some(Self {
            repo: text("repo")?,
            root: text("root")?,
            updated_at: text("updatedAt").unwrap_or_default(),
            activity: list("activity"),
            runs: object
                .get("runs")
                .and_then(Value::as_array)
                .map(|runs| runs.iter().filter_map(DeployRun::parse).collect())
                .unwrap_or_default(),
            issues: object
                .get("issues")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            issued_commits: list("issuedCommits"),
            last_commit: text("lastCommit"),
        })
    }
}

pub fn read_state(directory: &Path) -> Option<DeployState> {
    let text = crate::sampling::text(&state_path(directory))?;
    let value: Value = serde_json::from_str(&text).ok()?;
    DeployState::parse(&value)
}

pub fn write_state(directory: &Path, state: &DeployState) -> std::io::Result<()> {
    write_json_atomic(&state_path(directory), &state.to_json())
}

/// Appends one run, replacing an existing record with the same id so a run the
/// worker started and later settled keeps one entry, newest first.
fn record_run(runs: &[DeployRun], run: DeployRun) -> Vec<DeployRun> {
    let mut next: Vec<DeployRun> = runs
        .iter()
        .filter(|existing| existing.id != run.id)
        .cloned()
        .collect();
    next.insert(0, run);
    next.truncate(RUN_HISTORY_LIMIT);
    next
}

fn append_activity(lines: &mut Vec<String>, text: &str) {
    if lines.len() >= ACTIVITY_MAX_ENTRIES {
        lines.remove(0);
    }
    lines.push(text.to_string());
}

#[derive(Clone, Debug)]
pub struct DeployWorkerRecord {
    pub version: i64,
    pub pid: u32,
    pub start_ticks: Option<i64>,
    pub started_at: String,
    pub root: String,
    pub state_dir: String,
    pub lifecycle: AgentLifecycle,
    pub enabled: bool,
    pub paused: bool,
    pub harness_version: Option<String>,
    pub argv: Vec<String>,
    pub last_run_at: Option<String>,
    pub last_error: Option<String>,
    pub notice: Option<String>,
    pub active_run: Option<String>,
    pub baseline: Option<String>,
    pub updated_at: String,
}

impl DeployWorkerRecord {
    fn to_json(&self) -> Value {
        json!({
            "version": self.version,
            "pid": self.pid,
            "startTicks": self.start_ticks,
            "startedAt": self.started_at,
            "root": self.root,
            "stateDir": self.state_dir,
            "lifecycle": self.lifecycle.as_str(),
            "enabled": self.enabled,
            "paused": self.paused,
            "harnessVersion": self.harness_version,
            "argv": self.argv,
            "lastRunAt": self.last_run_at,
            "lastError": self.last_error,
            "notice": self.notice,
            "activeRun": self.active_run,
            "baseline": self.baseline,
            "updatedAt": self.updated_at,
        })
    }
}

pub fn parse_worker_state(text: &str) -> Option<DeployWorkerRecord> {
    let value: Value = serde_json::from_str(text).ok()?;
    let object = value.as_object()?;
    if object.get("version").and_then(Value::as_u64) != Some(WORKER_VERSION as u64) {
        return None;
    }
    let pid = u32::try_from(object.get("pid")?.as_u64()?).ok()?;
    if pid == 0 {
        return None;
    }
    let lifecycle = match object.get("lifecycle")?.as_str()? {
        "stopped" => AgentLifecycle::Stopped,
        "starting" => AgentLifecycle::Starting,
        "running" => AgentLifecycle::Running,
        "stopping" => AgentLifecycle::Stopping,
        "failed" => AgentLifecycle::Failed,
        _ => return None,
    };
    let text = |key: &str| object.get(key).and_then(Value::as_str).map(str::to_string);
    text("startedAt")?;
    text("root")?;
    text("stateDir")?;
    object.get("argv")?.as_array()?;
    Some(DeployWorkerRecord {
        version: WORKER_VERSION,
        pid,
        start_ticks: object.get("startTicks").and_then(Value::as_i64),
        started_at: text("startedAt")?,
        root: text("root")?,
        state_dir: text("stateDir")?,
        lifecycle,
        enabled: object.get("enabled")?.as_bool()?,
        paused: object.get("paused")?.as_bool()?,
        harness_version: text("harnessVersion"),
        argv: object
            .get("argv")?
            .as_array()?
            .iter()
            .filter_map(|entry| entry.as_str().map(str::to_string))
            .collect(),
        last_run_at: text("lastRunAt"),
        last_error: text("lastError"),
        notice: text("notice"),
        active_run: text("activeRun"),
        baseline: text("baseline"),
        updated_at: text("updatedAt").unwrap_or_default(),
    })
}

pub fn read_worker_state(path: &Path) -> Option<DeployWorkerRecord> {
    parse_worker_state(&crate::sampling::text(path)?)
}

pub fn write_worker_state(path: &Path, state: &DeployWorkerRecord) -> std::io::Result<()> {
    write_json_atomic(path, &state.to_json())
}

/// Every version's worker record, newest first by update time.
pub fn deploy_worker_states(directory: &Path) -> Vec<DeployWorkerRecord> {
    let mut states: Vec<DeployWorkerRecord> = worker_state_directories(directory)
        .into_iter()
        .filter_map(|directory| read_worker_state(&directory.join("worker.json")))
        .collect();
    states.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    states
}

/// Live owners of the family's shared lock, across every harness version.
pub fn deploy_owners(directory: &Path) -> Vec<LockOwner> {
    live_lock_owners(&lock_path(directory))
}

/* ------------------------------------------------------------------------ */
/* Settings                                                                  */
/* ------------------------------------------------------------------------ */

/// The deploy family has no interval: its trigger is an advance of `main`.
/// Only the filing limits are a setting.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DeploySettings {
    pub max_per_hour: Option<u32>,
    pub max_pending: Option<u32>,
}

impl DeploySettings {
    pub fn to_json(&self) -> Value {
        json!({
            "maxPerHour": self.max_per_hour,
            "maxPending": self.max_pending,
        })
    }
}

pub fn read_settings(directory: &Path) -> DeploySettings {
    let Some(text) = crate::sampling::text(&settings_path(directory)) else {
        return DeploySettings::default();
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return DeploySettings::default();
    };
    let limit = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_u64)
            .and_then(|number| u32::try_from(number).ok())
            .filter(|number| (1..=100).contains(number))
    };
    DeploySettings {
        max_per_hour: limit("maxPerHour"),
        max_pending: limit("maxPending"),
    }
}

pub fn write_settings(directory: &Path, settings: &DeploySettings) -> std::io::Result<()> {
    write_json_atomic(&settings_path(directory), &settings.to_json())
}

/* ------------------------------------------------------------------------ */
/* Runs                                                                      */
/* ------------------------------------------------------------------------ */

pub type ActivityFn = Arc<dyn Fn(&str) + Send + Sync>;
pub type StopFlag = Arc<dyn Fn() -> bool + Send + Sync>;

/// One run's inputs to the injected or default deploy runner.
#[derive(Clone)]
pub struct DeployRunInput {
    pub run: DeployRun,
    /// The `request.json` document the peer reads.
    pub request: Value,
    pub run_dir: PathBuf,
    pub repo_dir: PathBuf,
    pub worktree: PathBuf,
    pub state_dir: PathBuf,
    pub agent_command: String,
    pub environment: HashMap<String, String>,
    pub activity: ActivityFn,
    pub stopping: StopFlag,
    /// Records the peer this run started, so the state names it and Stop can
    /// close it.
    pub register_peer: Arc<dyn Fn(DeployPeer) + Send + Sync>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DeployRunResult {
    Succeeded { detail: Option<String> },
    Failed { detail: String },
    Skipped { detail: String },
    Stopped { detail: String },
}

impl DeployRunResult {
    pub fn failed(detail: impl Into<String>) -> Self {
        Self::Failed {
            detail: detail.into(),
        }
    }
}

pub type RunFuture = Pin<Box<dyn Future<Output = DeployRunResult> + Send>>;
pub type RunDeployFn = Arc<dyn Fn(DeployRunInput) -> RunFuture + Send + Sync>;

#[derive(Clone, Debug)]
pub struct IssueRequest {
    pub title: String,
    pub body: String,
}

pub type IssueFuture = Pin<Box<dyn Future<Output = Result<String, String>> + Send>>;
pub type IssueFn = Arc<dyn Fn(IssueRequest) -> IssueFuture + Send + Sync>;

/// The production deploy path: one `omp acp` peer running
/// `/deploy-on-main <run-dir>` from the deploy worktree.
pub fn default_run_deploy() -> RunDeployFn {
    Arc::new(|input: DeployRunInput| Box::pin(run_deploy_agent(input)))
}

async fn run_deploy_agent(input: DeployRunInput) -> DeployRunResult {
    if (input.stopping)() {
        return DeployRunResult::Stopped {
            detail: "stopped before the deploy started".to_string(),
        };
    }
    (input.activity)(&format!(
        "starting {} for {}",
        input.agent_command, input.run.commit
    ));
    let mut peer_environment = input.environment.clone();
    peer_environment.insert(
        "REPO_DIR".to_string(),
        input.repo_dir.to_string_lossy().into_owned(),
    );
    peer_environment.insert(
        "STATE_DIR".to_string(),
        input.state_dir.to_string_lossy().into_owned(),
    );
    peer_environment.insert(
        "DEVBOARD_DEPLOY_RUN_DIR".to_string(),
        input.run_dir.to_string_lossy().into_owned(),
    );
    let mcp_servers = crate::acp::session_mcp_servers(&peer_environment);
    let options = crate::acp::AcpConnectionOptions::new(
        input.agent_command.clone(),
        input.worktree.to_string_lossy().into_owned(),
    )
    .with_starter("Deploy on main")
    .with_env(peer_environment)
    .with_mcp_servers(mcp_servers)
    .with_permission_policy(crate::acp::PermissionPolicy::Deny);
    let connection = match crate::acp::AcpConnection::connect(options).await {
        Ok((connection, events)) => (connection, events),
        Err(error) => {
            return DeployRunResult::failed(format!("could not start the deploy agent: {error}"))
        }
    };
    let (connection, mut events) = connection;
    if let Some(pid) = connection.pid() {
        let argv = connection.argv();
        (input.register_peer)(DeployPeer {
            command: argv.join(" "),
            pid,
            argv,
            started_at: crate::journal::now_iso8601(),
        });
    }
    let prompt = format!("/deploy-on-main {}", input.run_dir.to_string_lossy());
    let future = connection.run(&prompt);
    tokio::pin!(future);
    let mut agent_error: Option<String> = None;
    let mut reported: Vec<String> = Vec::new();
    loop {
        if (input.stopping)() {
            connection.close();
            agent_error = Some("stopped during the deploy run".to_string());
            break;
        }
        tokio::select! {
            result = &mut future => {
                if let Err(error) = result {
                    agent_error = Some(error.to_string());
                }
                break;
            }
            event = events.recv() => {
                match event {
                    Some(crate::acp::AcpEvent::Text(chunk)) => reported.push(chunk),
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
                        if let Some(line) =
                            chunk.lines().map(str::trim).find(|line| !line.is_empty())
                        {
                            if line != "no diagnostic" {
                                (input.activity)(line);
                            }
                        }
                    }
                    Some(_) => {}
                    None => {}
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(100)) => {}
        }
    }
    connection.close();
    let stopped = (input.stopping)();
    let result = std::fs::read_to_string(input.run_dir.join("result.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let document = result;
    if stopped {
        return DeployRunResult::Stopped {
            detail: "stopped during the deploy run".to_string(),
        };
    }
    let Some(document) = document else {
        let detail = match agent_error {
            Some(error) => format!("the deploy agent ended with: {error}"),
            None => "the deploy agent finished without writing result.json".to_string(),
        };
        return DeployRunResult::failed(detail);
    };
    let detail = document
        .get("detail")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string);
    if document.get("skipped").and_then(Value::as_bool) == Some(true) {
        return DeployRunResult::Skipped {
            detail: detail.unwrap_or_else(|| "the host project has no deploy instructions".into()),
        };
    }
    match document.get("ok").and_then(Value::as_bool) {
        Some(true) => DeployRunResult::Succeeded { detail },
        Some(false) => DeployRunResult::Failed {
            detail: detail.unwrap_or_else(|| match agent_error {
                Some(error) => format!("the deploy agent failed: {error}"),
                None => "the deploy agent reported a failed deploy".to_string(),
            }),
        },
        None => DeployRunResult::Failed {
            detail: "the deploy agent's result.json carries no ok field".to_string(),
        },
    }
}

/// Files one issue on the configured Gitea forge. A failed run whose issue
/// cannot be filed keeps its commit unissued, so a later failure can file it
/// once; a filed commit is never filed twice.
fn default_issue_runner(repo_dir: PathBuf, environment: HashMap<String, String>) -> IssueFn {
    Arc::new(move |request: IssueRequest| {
        let repo_dir = repo_dir.clone();
        let environment = environment.clone();
        Box::pin(async move {
            let remote = crate::forge::origin_forge_with(&repo_dir, &environment)
                .filter(|remote| remote.forge == crate::forge::Forge::Gitea)
                .ok_or_else(|| "the origin is not a Gitea forge".to_string())?;
            let base_url = crate::forge::configured_gitea_url(&environment)
                .ok_or_else(|| "DEVBOARD_GITEA_URL is not configured".to_string())?;
            let token = crate::forge::configured_gitea_token(&environment);
            let target = crate::gitea::GiteaTarget {
                base_url,
                project: remote.project,
                token,
            };
            crate::gitea::create_issue(&target, &request.title, &request.body, None, 60_000)
                .await
                .map(|issue| issue.url)
                .map_err(|error| error.to_string())
        })
    })
}

/* ------------------------------------------------------------------------ */
/* The ref watcher                                                           */
/* ------------------------------------------------------------------------ */

/// Waits for the served checkout's `main` to move. The event is what starts a
/// run; there is no timer and no fetch.
#[cfg(target_os = "linux")]
struct RefWatcher {
    fd: tokio::io::unix::AsyncFd<std::os::fd::OwnedFd>,
}

#[cfg(target_os = "linux")]
impl RefWatcher {
    fn new(repo_dir: &Path) -> Option<Self> {
        use std::os::fd::FromRawFd as _;
        let directory = git_dir(repo_dir)?;
        let common = common_git_dir(repo_dir).unwrap_or_else(|| directory.clone());
        let fd = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
        if fd < 0 {
            return None;
        }
        let owned = unsafe { std::os::fd::OwnedFd::from_raw_fd(fd) };
        let mask = libc::IN_MODIFY
            | libc::IN_ATTRIB
            | libc::IN_MOVED_TO
            | libc::IN_CREATE
            | libc::IN_DELETE
            | libc::IN_CLOSE_WRITE
            | libc::IN_DELETE_SELF
            | libc::IN_MOVE_SELF;
        let mut watched = vec![directory.clone(), common.clone()];
        watched.push(common.join("refs/heads"));
        watched.push(common.join("logs/refs/heads"));
        watched.push(common.join("packed-refs"));
        watched.push(common.join("HEAD"));
        for path in watched {
            if !path.exists() {
                continue;
            }
            let Ok(text) = std::ffi::CString::new(path.to_string_lossy().as_bytes()) else {
                continue;
            };
            unsafe {
                libc::inotify_add_watch(fd, text.as_ptr(), mask);
            }
        }
        Some(Self {
            // Safety: the fd is owned by this struct and moved into the
            // registration exactly once; nothing else holds it.
            fd: unsafe { tokio::io::unix::AsyncFd::register(owned).ok()? },
        })
    }

    /// Resolves after one filesystem event, with no timeout of its own.
    async fn next_change(&self) -> bool {
        use std::os::fd::AsRawFd as _;
        loop {
            let Ok(mut guard) = self.fd.readable().await else {
                return false;
            };
            let mut buffer = [0u8; 8192];
            let read = guard.try_io(|inner| {
                let count = unsafe {
                    libc::read(
                        inner.as_raw_fd(),
                        buffer.as_mut_ptr() as *mut libc::c_void,
                        buffer.len(),
                    )
                };
                if count < 0 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(count as usize)
                }
            });
            match read {
                Ok(Ok(count)) => return count > 0,
                Ok(Err(_)) => return false,
                Err(_would_block) => continue,
            }
        }
    }
}

/// Everywhere else, the ref is read once a second. The trigger is still the
/// value, not the wait: this starts nothing a ref did not already say.
#[cfg(not(target_os = "linux"))]
struct RefWatcher;

#[cfg(not(target_os = "linux"))]
impl RefWatcher {
    fn new(_repo_dir: &Path) -> Option<Self> {
        Some(Self)
    }

    async fn next_change(&self) -> bool {
        tokio::time::sleep(Duration::from_secs(1)).await;
        true
    }
}

/* ------------------------------------------------------------------------ */
/* The worker                                                                */
/* ------------------------------------------------------------------------ */

pub type DeployLog = LogFn;

#[derive(Clone)]
pub struct DeployWorkerOptions {
    pub repo_dir: PathBuf,
    pub state_dir: PathBuf,
    pub owner_state_dir: Option<PathBuf>,
    pub harness_version: Option<String>,
    pub environment: Option<HashMap<String, String>>,
    pub agent_command: Option<String>,
    pub now: Option<Clock>,
    pub run_deploy: Option<RunDeployFn>,
    pub file_issue: Option<IssueFn>,
    pub log: Option<LogFn>,
    pub control_poll_ms: Option<u64>,
}

impl DeployWorkerOptions {
    pub fn new(repo_dir: impl Into<PathBuf>, state_dir: impl Into<PathBuf>) -> Self {
        Self {
            repo_dir: repo_dir.into(),
            state_dir: state_dir.into(),
            owner_state_dir: None,
            harness_version: None,
            environment: None,
            agent_command: None,
            now: None,
            run_deploy: None,
            file_issue: None,
            log: None,
            control_poll_ms: None,
        }
    }
}

struct Inner {
    shared: DeployState,
    settings: DeploySettings,
    worker: Option<DeployWorkerRecord>,
    lock: Option<AcquiredLock>,
    stopping: bool,
    draining: bool,
    paused: bool,
    active_run: Option<DeployRun>,
    /// The newest tip that arrived while a run was live.
    pending_commit: Option<String>,
    /// True when an operator check queued `pending_commit`, so the same tip a
    /// failed run already handled may run again.
    pending_force: bool,
    /// The newest tip a run was started for, or the start baseline.
    last_commit: Option<String>,
    notice: Option<String>,
}

impl Inner {
    fn new(repo_dir: &Path, now_ms: i64) -> Self {
        Self {
            shared: DeployState::empty("", &repo_dir.to_string_lossy(), now_ms),
            settings: DeploySettings::default(),
            worker: None,
            lock: None,
            stopping: false,
            draining: false,
            paused: false,
            active_run: None,
            pending_commit: None,
            pending_force: false,
            last_commit: None,
            notice: None,
        }
    }
}

/// The detached Deploy on main worker of one harness version.
pub struct DeployWorker {
    repo_dir: PathBuf,
    state_dir: PathBuf,
    owner_state_dir: PathBuf,
    harness_version: Option<String>,
    environment: HashMap<String, String>,
    agent_command: String,
    clock: Clock,
    run_deploy: RunDeployFn,
    file_issue: IssueFn,
    log: LogFn,
    control_poll_ms: u64,
    directory: PathBuf,
    version_control_directory: PathBuf,
    version_worker_path: PathBuf,
    inner: Arc<Mutex<Inner>>,
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn absolute(path: &Path) -> PathBuf {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|base| base.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };
    // One spelling of the served paths: every state record, worktree path,
    // and peer cwd names the same bytes.
    std::fs::canonicalize(&joined).unwrap_or(joined)
}

fn short_uuid() -> String {
    uuid::Uuid::new_v4().to_string().chars().take(8).collect()
}

impl DeployWorker {
    pub fn new(options: DeployWorkerOptions) -> Self {
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
        let started_now = clock();
        let directory = deploy_directory(&state_dir);
        let version_control_directory =
            versioned_control_directory(&directory, harness_version.as_deref());
        let version_worker_path =
            versioned_worker_state_path(&directory, harness_version.as_deref());
        let run_deploy = options.run_deploy.unwrap_or_else(default_run_deploy);
        let file_issue = options
            .file_issue
            .unwrap_or_else(|| default_issue_runner(repo_dir.clone(), environment.clone()));
        let inner = Arc::new(Mutex::new(Inner::new(&repo_dir, started_now)));
        Self {
            repo_dir,
            state_dir,
            owner_state_dir,
            harness_version,
            environment,
            agent_command: options
                .agent_command
                .unwrap_or_else(|| "omp acp".to_string()),
            clock,
            run_deploy,
            file_issue,
            log: options.log.unwrap_or_else(|| Arc::new(|_line: &str| {})),
            control_poll_ms: options.control_poll_ms.unwrap_or(CONTROL_POLL_MS).max(20),
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

    pub fn current_state(&self) -> DeployState {
        lock_unpoisoned(&self.inner).shared.clone()
    }

    pub fn current_worker(&self) -> Option<DeployWorkerRecord> {
        lock_unpoisoned(&self.inner).worker.clone()
    }

    pub fn active_run(&self) -> Option<DeployRun> {
        lock_unpoisoned(&self.inner).active_run.clone()
    }

    pub fn is_stopping(&self) -> bool {
        lock_unpoisoned(&self.inner).stopping
    }

    pub fn is_draining(&self) -> bool {
        lock_unpoisoned(&self.inner).draining
    }

    fn lock_details(&self) -> LockDetails {
        LockDetails::for_worker(
            &self.repo_dir,
            &self.owner_state_dir,
            self.harness_version.as_deref(),
        )
    }

    /// Takes this version's worker lock; false means another live worker owns
    /// it. The tip that exists now is the baseline: starting the family never
    /// deploys a commit that was already there.
    pub fn begin(&self) -> bool {
        let mut inner = lock_unpoisoned(&self.inner);
        let now = (self.clock)();
        inner.shared = read_state(&self.directory)
            .unwrap_or_else(|| DeployState::empty("", &self.repo_dir.to_string_lossy(), now));
        inner.settings = read_settings(&self.directory);
        inner.last_commit = main_commit(&self.repo_dir);
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
                (self.log)(&format!("deploy-on-main worker: already running{pid}"));
                return false;
            }
        };
        inner.lock = Some(lock);
        let started_at = iso_from_millis(now);
        inner.worker = Some(DeployWorkerRecord {
            version: WORKER_VERSION,
            pid: std::process::id(),
            start_ticks: crate::supervision::start_ticks(std::process::id()),
            started_at: started_at.clone(),
            root: self.repo_dir.to_string_lossy().into_owned(),
            state_dir: self.owner_state_dir.to_string_lossy().into_owned(),
            lifecycle: AgentLifecycle::Running,
            enabled: true,
            paused: false,
            harness_version: self.harness_version.clone(),
            argv: std::env::args().collect(),
            last_run_at: inner
                .shared
                .runs
                .first()
                .and_then(|run| run.ended_at.clone()),
            last_error: None,
            notice: None,
            active_run: None,
            baseline: inner.last_commit.clone(),
            updated_at: started_at,
        });
        self.persist(&mut inner);
        true
    }

    /// Runs until Stop ends it, or a drain finds nothing in flight.
    pub async fn run(&self) -> i32 {
        if !self.begin() {
            return 0;
        }
        self.consume();
        let watcher = RefWatcher::new(&self.repo_dir);
        let mut control = tokio::time::interval(Duration::from_millis(self.control_poll_ms));
        control.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        control.tick().await;
        loop {
            if self.is_stopping() || self.drain_settled() {
                break;
            }
            // A run that ended with an advance already recorded starts it now,
            // before the worker waits for the next event. A paused family keeps
            // its pending tip and starts nothing.
            if lock_unpoisoned(&self.inner).pending_commit.is_some() && self.start_pending().await {
                continue;
            }
            match watcher.as_ref() {
                Some(watcher) => {
                    let change = watcher.next_change();
                    tokio::pin!(change);
                    loop {
                        tokio::select! {
                            _ = &mut change => break,
                            _ = control.tick() => {
                                self.consume();
                                if lock_unpoisoned(&self.inner).pending_commit.is_some() {
                                    break;
                                }
                            }
                        }
                    }
                }
                None => {
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_millis(self.control_poll_ms)) => {}
                        _ = control.tick() => self.consume(),
                    }
                }
            }
            if self.is_stopping() || self.drain_settled() {
                break;
            }
            self.observe_tip();
            self.consume();
        }
        self.finish();
        0
    }

    /// One evaluation of the current tip, for `--once` and Check now. Starting
    /// the family still never runs the baseline tip; a tip whose last run
    /// failed or stopped is retried, because the operator asked for it.
    pub async fn evaluate_now(&self) {
        self.check_now();
        self.start_pending().await;
    }

    /// Queues the current tip for a run when it has not been handled, or when
    /// its last run failed or was stopped. The baseline tip that a Start
    /// observed is never queued by an untouched family.
    pub fn check_now(&self) {
        let Some(tip) = main_commit(&self.repo_dir) else {
            return;
        };
        let mut inner = lock_unpoisoned(&self.inner);
        if inner.pending_commit.is_some() {
            return;
        }
        let retry = inner
            .shared
            .runs
            .first()
            .map(|run| {
                run.commit == tip
                    && matches!(run.state, DeployRunState::Failed | DeployRunState::Stopped)
            })
            .unwrap_or(false);
        if inner.last_commit.as_deref() == Some(tip.as_str()) && !retry {
            return;
        }
        inner.pending_commit = Some(tip);
        inner.pending_force = true;
        self.publish_worker(&mut inner);
    }

    fn drain_settled(&self) -> bool {
        let inner = lock_unpoisoned(&self.inner);
        // A drain starts no new unit: a pending tip is dropped, never run.
        inner.draining && inner.active_run.is_none()
    }

    /// Records an advance of `main` that a run has not handled yet.
    fn observe_tip(&self) {
        let Some(tip) = main_commit(&self.repo_dir) else {
            return;
        };
        let mut inner = lock_unpoisoned(&self.inner);
        if inner.last_commit.as_deref() == Some(tip.as_str()) {
            if inner.pending_commit.as_deref() == Some(tip.as_str()) {
                inner.pending_commit = None;
            }
            return;
        }
        inner.pending_commit = Some(tip);
        inner.pending_force = false;
        self.publish_worker(&mut inner);
    }

    /// Starts the one pending run, if any. True when a run was started.
    async fn start_pending(&self) -> bool {
        let commit = {
            let mut inner = lock_unpoisoned(&self.inner);
            let Some(commit) = inner.pending_commit.clone() else {
                return false;
            };
            if inner.active_run.is_some() || inner.stopping || inner.draining || inner.paused {
                return false;
            }
            if inner.last_commit.as_deref() == Some(commit.as_str()) && !inner.pending_force {
                inner.pending_commit = None;
                return false;
            }
            inner.pending_commit = None;
            inner.pending_force = false;
            inner.last_commit = Some(commit.clone());
            commit
        };
        self.execute(commit).await;
        true
    }

    async fn execute(&self, commit: String) {
        let now = (self.clock)();
        let run_id = format!("{now}-{}", short_uuid());
        let worktree = deploy_worktree_path(&self.repo_dir);
        let run_dir = run_directory(&self.directory, &run_id);
        let mut run = DeployRun {
            id: run_id.clone(),
            started_at: Some(iso_from_millis(now)),
            ended_at: None,
            state: DeployRunState::Running,
            commit: commit.clone(),
            worktree: worktree.to_string_lossy().into_owned(),
            detail: None,
            peer: None,
        };
        {
            let mut inner = lock_unpoisoned(&self.inner);
            inner.active_run = Some(run.clone());
            inner.shared.runs = record_run(&inner.shared.runs, run.clone());
            inner.shared.last_commit = Some(commit.clone());
            if let Some(worker) = inner.worker.as_mut() {
                worker.active_run = Some(run_id.clone());
                worker.lifecycle = AgentLifecycle::Running;
                worker.last_error = None;
                inner.notice = Some(format!("deploying {}", short_commit(&commit)));
            }
            self.persist(&mut inner);
        }
        self.activity(&format!(
            "deploy run {} started for {} from {}",
            run_id,
            short_commit(&commit),
            worktree.display()
        ));
        if let Err(error) = std::fs::create_dir_all(&run_dir) {
            self.settle(
                run,
                DeployRunResult::failed(format!(
                    "could not create the run directory {}: {error}",
                    run_dir.display()
                )),
            )
            .await;
            return;
        }
        if let Err(detail) = fast_forward_worktree(&self.repo_dir, &worktree, &commit) {
            self.settle(run, DeployRunResult::failed(detail)).await;
            return;
        }
        let instructions_file = worktree.join("AGENTS.md");
        let instructions = match std::fs::read_to_string(&instructions_file) {
            Ok(text) => match deploy_instructions(&text) {
                Some(section) => section,
                None => {
                    self.settle(
                        run,
                        DeployRunResult::Skipped {
                            detail: format!(
                                "the host project's AGENTS.md at {} carries no deploy instructions",
                                instructions_file.display()
                            ),
                        },
                    )
                    .await;
                    return;
                }
            },
            Err(_) => {
                self.settle(
                    run,
                    DeployRunResult::Skipped {
                        detail: format!(
                            "the host project has no AGENTS.md deploy instructions ({} is missing)",
                            instructions_file.display()
                        ),
                    },
                )
                .await;
                return;
            }
        };
        let request = json!({
            "format": 1,
            "runId": run_id,
            "commit": commit,
            "servedCheckout": self.repo_dir.to_string_lossy(),
            "deployWorktree": worktree.to_string_lossy(),
            "instructionsFile": instructions_file.to_string_lossy(),
            "instructions": instructions,
        });
        if let Err(error) = write_json_atomic(&request_path(&self.directory, &run_id), &request) {
            self.settle(
                run,
                DeployRunResult::failed(format!("could not write the run request: {error}")),
            )
            .await;
            return;
        }
        let active = lock_unpoisoned(&self.inner)
            .active_run
            .as_ref()
            .and_then(|active| active.peer.clone());
        let _ = active;
        let input = DeployRunInput {
            run: run.clone(),
            request,
            run_dir,
            repo_dir: self.repo_dir.clone(),
            worktree: worktree.clone(),
            state_dir: self.state_dir.clone(),
            agent_command: self.agent_command.clone(),
            environment: self.environment.clone(),
            activity: self.activity_callback(),
            stopping: {
                let inner = self.inner.clone();
                Arc::new(move || lock_unpoisoned(&inner).stopping)
            },
            register_peer: {
                let inner = self.inner.clone();
                let run_id = run_id.clone();
                Arc::new(move |peer: DeployPeer| {
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
                })
            },
        };
        let result = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            (self.run_deploy)(input)
        })) {
            Ok(future) => future.await,
            Err(_) => DeployRunResult::failed("the deploy agent panicked"),
        };
        run.peer = lock_unpoisoned(&self.inner)
            .active_run
            .as_ref()
            .and_then(|active| active.peer.clone());
        self.settle(run, result).await;
    }

    async fn settle(&self, mut run: DeployRun, result: DeployRunResult) {
        let ended_at = iso_from_millis((self.clock)());
        run.ended_at = Some(ended_at.clone());
        let (notice, failure) = match &result {
            DeployRunResult::Succeeded { detail } => {
                run.state = DeployRunState::Succeeded;
                run.detail = detail.clone();
                (format!("deployed {}", short_commit(&run.commit)), None)
            }
            DeployRunResult::Failed { detail } => {
                run.state = DeployRunState::Failed;
                run.detail = Some(detail.clone());
                (format!("deploy failed: {detail}"), Some(detail.clone()))
            }
            DeployRunResult::Skipped { detail } => {
                run.state = DeployRunState::Skipped;
                run.detail = Some(detail.clone());
                (format!("deploy skipped: {detail}"), None)
            }
            DeployRunResult::Stopped { detail } => {
                run.state = DeployRunState::Stopped;
                run.detail = Some(detail.clone());
                (format!("deploy stopped: {detail}"), None)
            }
        };
        {
            let mut inner = lock_unpoisoned(&self.inner);
            inner.shared.runs = record_run(&inner.shared.runs, run.clone());
            inner.shared.last_commit = Some(run.commit.clone());
            inner.active_run = None;
            inner.notice = Some(notice.clone());
            if let Some(worker) = inner.worker.as_mut() {
                worker.active_run = None;
                worker.last_run_at = Some(ended_at);
                worker.notice = Some(notice.clone());
                match &failure {
                    Some(detail) => {
                        worker.lifecycle = AgentLifecycle::Failed;
                        worker.last_error = Some(detail.clone());
                    }
                    None => {
                        worker.lifecycle = AgentLifecycle::Running;
                        worker.last_error = None;
                    }
                }
            }
            self.persist(&mut inner);
        }
        self.activity(&format!(
            "deploy run {} {} for {} from {}",
            run.id,
            run.state.as_str(),
            short_commit(&run.commit),
            run.worktree
        ));
        if let Some(detail) = failure {
            self.file_issue_once(&run, &detail).await;
        }
    }

    /// At most one issue per triggering commit: a repeated failure for the same
    /// commit files none.
    async fn file_issue_once(&self, run: &DeployRun, detail: &str) {
        {
            let inner = lock_unpoisoned(&self.inner);
            if inner
                .shared
                .issued_commits
                .iter()
                .any(|commit| commit == &run.commit)
            {
                return;
            }
        }
        let title = format!("Deploy on main failed at {}", short_commit(&run.commit));
        let body = format!(
            "The deploy-on-main family failed to deploy {} from {}.\n\n{}\n",
            run.commit, run.worktree, detail
        );
        let request = IssueRequest {
            title: title.clone(),
            body,
        };
        let result = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            (self.file_issue)(request)
        })) {
            Ok(future) => future.await,
            Err(_) => Err("the issue runner panicked".to_string()),
        };
        match result {
            Ok(url) => {
                let at = iso_from_millis((self.clock)());
                let mut inner = lock_unpoisoned(&self.inner);
                inner.shared.issued_commits.push(run.commit.clone());
                inner.shared.issues.push(json!({
                    "title": title,
                    "category": "deploy",
                    "createdAt": at,
                    "url": url,
                    "state": "filed",
                    "version": null,
                    "note": null,
                }));
                self.persist(&mut inner);
            }
            Err(error) => {
                (self.log)(&format!(
                    "deploy-on-main: could not file the issue: {error}"
                ));
            }
        }
    }

    fn activity_callback(&self) -> ActivityFn {
        let inner = self.inner.clone();
        let directory = self.directory.clone();
        let clock = self.clock.clone();
        Arc::new(move |line: &str| {
            let mut state = lock_unpoisoned(&inner);
            append_activity(&mut state.shared.activity, line);
            if let Some(run) = state.active_run.clone() {
                let lines: Vec<String> = vec![line.to_string()];
                write_run_activity(&run_directory(&directory, &run.id), &lines, true);
            }
            state.shared.updated_at = iso_from_millis(clock());
            let _ = write_state(&directory, &state.shared);
        })
    }

    fn activity(&self, line: &str) {
        (self.activity_callback())(line);
    }

    fn persist(&self, inner: &mut Inner) {
        inner.shared.updated_at = iso_from_millis((self.clock)());
        if write_state(&self.directory, &inner.shared).is_err() {
            (self.log)("deploy-on-main: could not write the state file");
        }
        self.publish_worker(inner);
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
                "could not write the deploy-on-main worker state: {error}"
            ));
        }
    }

    fn finish(&self) {
        let mut inner = lock_unpoisoned(&self.inner);
        inner.notice = if inner.draining {
            Some("Drained: exited after its in-flight run.".to_string())
        } else {
            None
        };
        if let Some(worker) = inner.worker.as_mut() {
            worker.lifecycle = AgentLifecycle::Stopped;
            worker.enabled = false;
        }
        self.publish_worker(&mut inner);
        if let Some(lock) = inner.lock.take() {
            lock.release();
        }
    }

    /// Consumes the dashboard's control files between ref events.
    pub fn consume(&self) {
        for command in take_commands(&self.version_control_directory) {
            self.apply(command);
        }
    }

    fn apply(&self, command: DeployCommand) {
        match command {
            DeployCommand::Stop => {
                lock_unpoisoned(&self.inner).stopping = true;
            }
            DeployCommand::Drain => {
                let mut inner = lock_unpoisoned(&self.inner);
                inner.draining = true;
                inner.pending_commit = None;
                inner.pending_force = false;
                if inner.worker.is_some() {
                    inner.notice = Some("draining after the active run".to_string());
                }
                self.publish_worker(&mut inner);
            }
            DeployCommand::Pause => {
                let mut inner = lock_unpoisoned(&self.inner);
                inner.paused = true;
                if let Some(worker) = inner.worker.as_mut() {
                    worker.paused = true;
                }
                inner.notice = Some("paused".to_string());
                self.publish_worker(&mut inner);
            }
            DeployCommand::Resume => {
                let mut inner = lock_unpoisoned(&self.inner);
                inner.paused = false;
                if let Some(worker) = inner.worker.as_mut() {
                    worker.paused = false;
                }
                inner.notice = Some("resumed".to_string());
                self.publish_worker(&mut inner);
            }
            DeployCommand::Check => {
                {
                    let mut inner = lock_unpoisoned(&self.inner);
                    inner.notice = Some("check requested".to_string());
                }
                self.check_now();
            }
        }
    }

    /// Stops this worker; the run in flight ends and is recorded as stopped.
    pub async fn stop(&self) {
        lock_unpoisoned(&self.inner).stopping = true;
        while lock_unpoisoned(&self.inner).active_run.is_some() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        self.finish();
    }

    /// Forces one evaluation against the current tip, for `--once`.
    pub async fn tick_now(&self) {
        self.evaluate_now().await;
    }
}

fn write_run_activity(run_dir: &Path, lines: &[String], append: bool) {
    if std::fs::create_dir_all(run_dir).is_err() {
        return;
    }
    let path = run_dir.join("activity.json");
    let mut existing: Vec<String> = if append {
        crate::sampling::json(&path)
            .and_then(|value| value.as_array().cloned())
            .map(|entries| {
                entries
                    .into_iter()
                    .filter_map(|entry| entry.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    for line in lines {
        append_activity(&mut existing, line);
    }
    if let Ok(text) = serde_json::to_string(&existing) {
        let _ = std::fs::write(&path, format!("{text}\n"));
    }
}

fn short_commit(commit: &str) -> String {
    commit.chars().take(7).collect()
}

/* ------------------------------------------------------------------------ */
/* Control                                                                   */
/* ------------------------------------------------------------------------ */

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeployCommand {
    Stop,
    Drain,
    Pause,
    Resume,
    Check,
}

pub fn parse_command(text: &str) -> Option<DeployCommand> {
    let value: Value = serde_json::from_str(text).ok()?;
    Some(match value.get("type")?.as_str()? {
        "stop" => DeployCommand::Stop,
        "drain" => DeployCommand::Drain,
        "pause" => DeployCommand::Pause,
        "resume" => DeployCommand::Resume,
        "check" => DeployCommand::Check,
        _ => return None,
    })
}

pub fn write_command(directory: &Path, command: &Value) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(directory)?;
    let name = format!(
        "{}-{}.json",
        iso_from_millis(now_millis()).replace([':', '.'], "-"),
        short_uuid()
    );
    let path = directory.join(name);
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, format!("{command}\n"))?;
    std::fs::rename(&temporary, &path)?;
    Ok(path)
}

pub fn take_commands(directory: &Path) -> Vec<DeployCommand> {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
    paths.sort();
    let mut commands = Vec::new();
    for path in paths {
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let Some(text) = crate::sampling::text(&path) else {
            continue;
        };
        if let Some(command) = parse_command(&text) {
            commands.push(command);
        }
        let _ = std::fs::remove_file(&path);
    }
    commands
}

/* ------------------------------------------------------------------------ */
/* The worker entry point                                                    */
/* ------------------------------------------------------------------------ */

fn usage() -> anyhow::Error {
    anyhow::anyhow!(
        "usage: devboard worker deploy-on-main --repo <checkout> [--state-dir <state>] \
         [--once] [--json] [--harness-version <version>]"
    )
}

/// The Deploy on main family: no cadence, no timer. `--once` evaluates the
/// current tip and exits; the plain form waits for the served checkout's
/// `main` to move until Stop or a drain.
pub async fn run(invocation: &WorkerInvocation) -> anyhow::Result<()> {
    let mut state_dir: Option<PathBuf> = None;
    let mut once = false;
    let mut json_output = false;
    let mut harness_version: Option<String> = None;
    let mut index = 0;
    while index < invocation.rest.len() {
        match invocation.rest[index].as_str() {
            "--state-dir" => {
                state_dir = invocation.rest.get(index + 1).map(PathBuf::from);
                index += 2;
            }
            "--once" => {
                once = true;
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
            other => anyhow::bail!("deploy-on-main: unexpected argument {other}"),
        }
    }
    let repo_dir = if invocation.repo_dir.as_os_str().is_empty() {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    } else {
        invocation.repo_dir.clone()
    };
    let repo_dir = absolute(&repo_dir);
    let harness = repo_dir.join(".devboard");
    if !harness.exists() {
        eprintln!(
            "deploy-on-main: missing prerequisite: {} does not exist",
            harness.display()
        );
        std::process::exit(2);
    }
    if main_commit(&repo_dir).is_none() {
        eprintln!(
            "deploy-on-main: missing prerequisite: {} has no main branch",
            repo_dir.display()
        );
        std::process::exit(2);
    }
    let state_dir = state_dir.unwrap_or_else(|| {
        if invocation.state_dir.as_os_str().is_empty() {
            repo_dir.join(".devboard").join(".tmp")
        } else {
            invocation.state_dir.clone()
        }
    });
    let mut options = DeployWorkerOptions::new(repo_dir, state_dir);
    options.harness_version = harness_version;
    let worker = DeployWorker::new(options);
    if once {
        if !worker.begin() {
            eprintln!("deploy-on-main: another worker of this version is running");
            std::process::exit(2);
        }
        worker.tick_now().await;
        let state = worker.current_state();
        if json_output {
            println!("{}", serde_json::to_string_pretty(&state.to_json())?);
        }
        worker.stop().await;
        return Ok(());
    }
    let code = worker.run().await;
    if code != 0 {
        std::process::exit(code);
    }
    Ok(())
}
