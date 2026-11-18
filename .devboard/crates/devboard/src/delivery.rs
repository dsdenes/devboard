//! The per-repository delivery mode: whether a background family that
//! produces a git change lands it on the integration branch or opens one
//! ready pull request.
//!
//! The mode is one discriminated setting in the dashboard's per-repository
//! state file, read by the dashboard and by every detached worker. It is
//! available only on host projects; a harness source checkout stays pinned to
//! `merge`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};

use crate::app::{App, Conn, Shared, StateSection};
use crate::command::Command;
use crate::project_kind::ProjectKind;

/// The reason a harness source checkout carries, in the exact wording the
/// operator sees in the sidebar.
pub const HARNESS_REFUSAL: &str =
    "Delivery mode applies to host projects; this project is the harness source checkout.";

/// The background families that only file issues: they produce no git change
/// in either delivery mode, so they never push a branch and never open a pull
/// request.
pub const FILE_ONLY_FAMILIES: [&str; 7] = [
    "scout",
    "watchdog",
    "dead-code",
    "mcp-optimizer",
    "api-standards",
    "single-responsibility",
    "consistent-naming",
];

/// What a background family does with the change it produced.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeliveryMode {
    /// Land on the integration branch, exactly as the harness did before the
    /// switch.
    Merge,
    /// Push a branch and open one ready pull request; never advance the
    /// integration branch.
    PullRequest,
}

impl DeliveryMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Merge => "merge",
            Self::PullRequest => "pull-request",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "merge" => Some(Self::Merge),
            "pull-request" => Some(Self::PullRequest),
            _ => None,
        }
    }
}

impl Default for DeliveryMode {
    fn default() -> Self {
        Self::Merge
    }
}

/// The mode one repository effectively uses: a harness source checkout is
/// always `merge`, whatever is saved.
pub fn effective(saved: DeliveryMode, kind: ProjectKind) -> DeliveryMode {
    match kind {
        ProjectKind::HarnessSource => DeliveryMode::Merge,
        ProjectKind::Host => saved,
    }
}

/// The availability one project kind reports.
pub fn availability(kind: ProjectKind) -> Value {
    match kind {
        ProjectKind::Host => json!({"state": "enabled", "reason": null}),
        ProjectKind::HarnessSource => json!({"state": "disabled", "reason": HARNESS_REFUSAL}),
    }
}

/// The delivery fields every `project` payload carries.
pub fn project_fields(saved: DeliveryMode, kind: ProjectKind) -> (String, Value) {
    (
        effective(saved, kind).as_str().to_string(),
        availability(kind),
    )
}

/// The saved mode in one repository's dashboard state file. A missing file,
/// missing key, or unknown value reads `merge`: the default and the only mode
/// a fresh repository has ever used.
pub fn saved_mode(state_dir: &Path, repo_dir: &Path) -> DeliveryMode {
    // A side-effect-free read: the dashboard's own restore owns preserving a
    // damaged file and reporting it, so the setting never moves those bytes.
    let path = crate::state::state_file(state_dir, repo_dir);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return DeliveryMode::Merge;
    };
    let Ok(envelope) = serde_json::from_str::<Value>(&text) else {
        return DeliveryMode::Merge;
    };
    if envelope.get("version").and_then(Value::as_u64) != Some(crate::state::STATE_VERSION as u64) {
        return DeliveryMode::Merge;
    }
    envelope
        .get("state")
        .and_then(|state| state.get("deliveryMode"))
        .and_then(Value::as_str)
        .and_then(DeliveryMode::parse)
        .unwrap_or_default()
}

/// The mode one repository effectively uses, read from its state file.
pub fn mode_for(state_dir: &Path, repo_dir: &Path) -> DeliveryMode {
    effective(
        saved_mode(state_dir, repo_dir),
        crate::project_kind::of(repo_dir),
    )
}

/// The dashboard's in-memory setting. The registered state section writes the
/// same value the workers read.
pub struct DeliverySetting {
    repo_dir: PathBuf,
    state_dir: PathBuf,
    kind: ProjectKind,
    saved: Mutex<DeliveryMode>,
}

impl DeliverySetting {
    pub fn new(repo_dir: PathBuf, state_dir: PathBuf) -> Self {
        let saved = saved_mode(&state_dir, &repo_dir);
        Self {
            kind: crate::project_kind::of(&repo_dir),
            repo_dir,
            state_dir,
            saved: Mutex::new(saved),
        }
    }

    pub fn saved(&self) -> DeliveryMode {
        self.saved.lock().map(|saved| *saved).unwrap_or_default()
    }

    pub fn effective(&self) -> DeliveryMode {
        effective(self.saved(), self.kind)
    }

    pub fn kind(&self) -> ProjectKind {
        self.kind
    }

    /// Stores one mode and hands back the section value. A harness source
    /// checkout refuses `pull-request` without changing anything.
    pub fn set(&self, mode: DeliveryMode) -> Result<(), String> {
        if mode == DeliveryMode::PullRequest && self.kind == ProjectKind::HarnessSource {
            return Err(format!("{HARNESS_REFUSAL} The saved mode is unchanged."));
        }
        if let Ok(mut saved) = self.saved.lock() {
            *saved = mode;
        }
        Ok(())
    }

    /// The frame every page reads.
    pub fn project_frame(&self) -> Value {
        let (mode, availability) = project_fields(self.saved(), self.kind);
        json!({
            "type": "project",
            "path": project_label(&self.repo_dir),
            "deliveryMode": mode,
            "deliveryModeAvailability": availability,
        })
    }

    pub fn state_dir(&self) -> &Path {
        &self.state_dir
    }

    pub fn repo_dir(&self) -> &Path {
        &self.repo_dir
    }
}

impl StateSection for DeliverySetting {
    fn snapshot(&self) -> Option<Value> {
        Some(Value::String(self.saved().as_str().to_string()))
    }

    fn restore(&self, value: &Value) {
        let Some(mode) = value.as_str().and_then(DeliveryMode::parse) else {
            return;
        };
        if mode == DeliveryMode::PullRequest && self.kind == ProjectKind::HarnessSource {
            return;
        }
        if let Ok(mut saved) = self.saved.lock() {
            *saved = mode;
        }
    }
}

/// The label the project frame carries; the client's status bar derives the
/// project name from it: its path relative to the user's home, or the absolute
/// path outside it. This is the only `path` rule a project frame has, so
/// `getProject` and a delivery-mode save answer the same string.
pub fn project_label(repo_dir: &Path) -> String {
    let root = repo_dir
        .canonicalize()
        .unwrap_or_else(|_| repo_dir.to_path_buf());
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return root.to_string_lossy().into_owned();
    };
    let home = home.canonicalize().unwrap_or(home);
    match root.strip_prefix(&home) {
        Ok(relative) if !relative.as_os_str().is_empty() => relative.to_string_lossy().into_owned(),
        _ => root.to_string_lossy().into_owned(),
    }
}

/// Registers the setting on one dashboard and returns it.
pub fn init(shared: &Shared, repo_dir: &Path, state_dir: &Path) -> std::sync::Arc<DeliverySetting> {
    let setting = std::sync::Arc::new(DeliverySetting::new(
        repo_dir.to_path_buf(),
        state_dir.to_path_buf(),
    ));
    shared.register_section("deliveryMode", setting.clone());
    setting
}

/// One refusal frame. It names the save's own request id when the page sent
/// one, so a page settles that save and never a refusal another command raised.
fn refused(request_id: Option<&Value>, message: String) -> Value {
    let mut frame = json!({"type": "error", "message": message});
    if let Some(request_id) = request_id {
        frame["requestId"] = request_id.clone();
    }
    frame
}

/// Answers `setDeliveryMode`: parses the one field, refuses an unknown value
/// and a harness checkout, persists the accepted value, and answers the whole
/// project payload under the save's own request id.
pub fn handle(app: &std::sync::Arc<App>, conn: &Conn, command: &Command) -> bool {
    let Command::SetDeliveryMode { mode, request_id } = command else {
        return false;
    };
    let request_id = request_id.as_ref();
    let Some(text) = mode.as_ref().and_then(Value::as_str) else {
        conn.send(refused(
            request_id,
            "A delivery mode needs `merge` or `pull-request`.".to_string(),
        ));
        return true;
    };
    let Some(mode) = DeliveryMode::parse(text) else {
        conn.send(refused(
            request_id,
            format!("Unknown delivery mode {text:?}; use `merge` or `pull-request`."),
        ));
        return true;
    };
    let setting = &app.delivery;
    if mode == DeliveryMode::PullRequest && setting.kind() == ProjectKind::HarnessSource {
        conn.send(refused(
            request_id,
            format!("{HARNESS_REFUSAL} The saved mode is unchanged."),
        ));
        return true;
    }
    if let Err(message) = setting.set(mode) {
        conn.send(refused(request_id, message));
        return true;
    }
    // Flush the registered section before the answer, so the frame a page
    // applies is the value a restart reads back.
    app.shared.flush_state();
    let frame = setting.project_frame();
    // The answer names the save it settles. The broadcast carries the plain
    // payload: no other page awaits this save.
    let mut answer = frame.clone();
    if let Some(request_id) = request_id {
        answer["requestId"] = request_id.clone();
    }
    conn.send(answer);
    app.shared.broadcast(frame);
    true
}

/* ------------------------------------------------------------------------ */
/* Pull-request delivery                                                     */
/* ------------------------------------------------------------------------ */

/// One pull request an agent opened for one issue or documentation entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeliveredPullRequest {
    pub number: u64,
    pub url: String,
    pub state: String,
    pub branch: String,
    pub base: String,
    pub head: String,
}

impl DeliveredPullRequest {
    pub fn json(&self) -> Value {
        json!({
            "number": self.number,
            "url": self.url,
            "state": self.state,
        })
    }
}

/// The branch one issue's implementation pushes in pull-request mode. It is
/// deterministic per run, so a replay of the same run reuses the same branch
/// and its open pull request.
pub fn issue_branch(number: u64, run_id: &str) -> String {
    let token: String = run_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(12)
        .collect();
    let token = if token.is_empty() {
        "run".to_string()
    } else {
        token
    };
    format!("devboard/issue-{number}-{token}")
}

/// The documentation branch one Design System cycle pushes in pull-request
/// mode.
pub fn design_branch(cycle_id: &str) -> String {
    format!("devboard/design-{cycle_id}")
}

/// The closing keyword a pull request body uses for one issue. Both supported
/// forges accept `Closes`.
pub fn closing_keyword(number: u64) -> String {
    format!("Closes #{number}")
}

/* ------------------------------------------------------------------------ */
/* Maintenance records                                                       */
/* ------------------------------------------------------------------------ */

/// One agent-opened pull request the Issues worker maintains.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MaintenanceRecord {
    pub id: String,
    pub pull_request: DeliveredPullRequest,
    pub issue: Option<u64>,
    pub documentation: Option<String>,
    /// The head commit the record last observed.
    pub head_commit: String,
    /// The newest review comment id whose reply this worker posted.
    pub last_handled_comment: Option<u64>,
    /// The last observed required-check state, `green`, `failed`, or
    /// `pending`.
    pub check_state: String,
    /// The last observed mergeability, `mergeable`, `conflicting`, or
    /// `unknown`.
    pub mergeable_state: String,
    /// `open`, `merged`, or `closed`.
    pub state: String,
    /// The mode the request was opened under, kept so a switch back to merge
    /// never changes how an existing request is maintained.
    pub mode: DeliveryMode,
}

impl MaintenanceRecord {
    pub fn new(
        pull_request: DeliveredPullRequest,
        issue: Option<u64>,
        documentation: Option<String>,
    ) -> Self {
        Self {
            id: pull_request.number.to_string(),
            head_commit: pull_request.head.clone(),
            pull_request,
            issue,
            documentation,
            last_handled_comment: None,
            check_state: "unknown".to_string(),
            mergeable_state: "unknown".to_string(),
            state: "open".to_string(),
            mode: DeliveryMode::PullRequest,
        }
    }

    pub fn is_open(&self) -> bool {
        self.state == "open"
    }
}

fn maintenance_directory(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    state_dir
        .join("delivery")
        .join(crate::journal::repo_key(repo_dir))
}

fn maintenance_path(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    maintenance_directory(state_dir, repo_dir).join("maintenance.json")
}

/// Reads every maintenance record for one repository.
pub fn read_maintenance(state_dir: &Path, repo_dir: &Path) -> Vec<MaintenanceRecord> {
    let text = match std::fs::read_to_string(maintenance_path(state_dir, repo_dir)) {
        Ok(text) => text,
        Err(_) => return Vec::new(),
    };
    let value: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let Some(rows) = value.get("records").and_then(Value::as_array) else {
        return Vec::new();
    };
    rows.iter().filter_map(record_from_json).collect()
}

fn record_from_json(value: &Value) -> Option<MaintenanceRecord> {
    let row = value.as_object()?;
    let pull_request = row.get("pullRequest")?.as_object()?;
    let number = pull_request.get("number")?.as_u64()?;
    let url = pull_request.get("url")?.as_str()?.to_string();
    let state = pull_request.get("state")?.as_str()?.to_string();
    let branch = pull_request.get("branch")?.as_str()?.to_string();
    let base = pull_request.get("base")?.as_str()?.to_string();
    let head = pull_request.get("head")?.as_str()?.to_string();
    Some(MaintenanceRecord {
        id: row.get("id")?.as_str()?.to_string(),
        pull_request: DeliveredPullRequest {
            number,
            url,
            state,
            branch,
            base,
            head,
        },
        issue: row.get("issue").and_then(Value::as_u64),
        documentation: row
            .get("documentation")
            .and_then(Value::as_str)
            .map(str::to_string),
        head_commit: row.get("headCommit")?.as_str()?.to_string(),
        last_handled_comment: row.get("lastHandledComment").and_then(Value::as_u64),
        check_state: row
            .get("checkState")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        mergeable_state: row
            .get("mergeableState")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        state: row
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("open")
            .to_string(),
        mode: row
            .get("mode")
            .and_then(Value::as_str)
            .and_then(DeliveryMode::parse)
            .unwrap_or(DeliveryMode::PullRequest),
    })
}

fn record_to_json(record: &MaintenanceRecord) -> Value {
    json!({
        "id": record.id,
        "pullRequest": {
            "number": record.pull_request.number,
            "url": record.pull_request.url,
            "state": record.pull_request.state,
            "branch": record.pull_request.branch,
            "base": record.pull_request.base,
            "head": record.pull_request.head,
        },
        "issue": record.issue,
        "documentation": record.documentation,
        "headCommit": record.head_commit,
        "lastHandledComment": record.last_handled_comment,
        "checkState": record.check_state,
        "mergeableState": record.mergeable_state,
        "state": record.state,
        "mode": record.mode.as_str(),
    })
}

/// Writes every maintenance record atomically.
pub fn write_maintenance(
    state_dir: &Path,
    repo_dir: &Path,
    records: &[MaintenanceRecord],
) -> std::io::Result<()> {
    let path = maintenance_path(state_dir, repo_dir);
    let rows: Vec<Value> = records.iter().map(record_to_json).collect();
    let text = crate::jsjson::stringify(&json!({"version": 1, "records": rows}));
    crate::state::write_file_atomically_sync(&path, &format!("{text}\n"))
}

/// Inserts or replaces one record by its pull request number.
pub fn upsert_maintenance(
    state_dir: &Path,
    repo_dir: &Path,
    record: MaintenanceRecord,
) -> std::io::Result<Vec<MaintenanceRecord>> {
    let mut records = read_maintenance(state_dir, repo_dir);
    match records.iter_mut().find(|existing| existing.id == record.id) {
        Some(existing) => *existing = record,
        None => records.push(record),
    }
    write_maintenance(state_dir, repo_dir, &records)?;
    Ok(records)
}

/// The open record for one issue, if an agent already opened a pull request
/// for it.
pub fn open_record_for_issue(
    state_dir: &Path,
    repo_dir: &Path,
    issue: u64,
) -> Option<MaintenanceRecord> {
    read_maintenance(state_dir, repo_dir)
        .into_iter()
        .find(|record| record.issue == Some(issue) && record.is_open())
}

/// The open record for one documentation entry, if any.
pub fn open_record_for_documentation(
    state_dir: &Path,
    repo_dir: &Path,
    entry: &str,
) -> Option<MaintenanceRecord> {
    read_maintenance(state_dir, repo_dir)
        .into_iter()
        .find(|record| record.documentation.as_deref() == Some(entry) && record.is_open())
}

/// A branch name no closed record holds, so a requeued issue never reuses or
/// force-updates a closed pull request's branch.
pub fn fresh_issue_branch(state_dir: &Path, repo_dir: &Path, number: u64, run_id: &str) -> String {
    let base = issue_branch(number, run_id);
    let used: Vec<String> = read_maintenance(state_dir, repo_dir)
        .into_iter()
        .map(|record| record.pull_request.branch)
        .collect();
    if !used.iter().any(|branch| branch == &base) {
        return base;
    }
    let mut suffix = 2;
    loop {
        let candidate = format!("{base}-{suffix}");
        if !used.iter().any(|branch| branch == &candidate) {
            return candidate;
        }
        suffix += 1;
    }
}

/// The environment a maintenance peer reads.
pub fn maintenance_environment(record: &MaintenanceRecord) -> HashMap<String, String> {
    let mut environment = HashMap::new();
    let number = record.pull_request.number;
    environment.insert("DEVBOARD_PR_NUMBER".to_string(), number.to_string());
    environment.insert(
        "DEVBOARD_PR_URL".to_string(),
        record.pull_request.url.clone(),
    );
    environment.insert(
        "DEVBOARD_PR_BRANCH".to_string(),
        record.pull_request.branch.clone(),
    );
    environment.insert(
        "DEVBOARD_PR_BASE".to_string(),
        record.pull_request.base.clone(),
    );
    environment.insert("DEVBOARD_PR_HEAD".to_string(), record.head_commit.clone());
    if let Some(issue) = record.issue {
        environment.insert("DEVBOARD_PR_ISSUE".to_string(), issue.to_string());
    }
    if let Some(documentation) = &record.documentation {
        environment.insert(
            "DEVBOARD_PR_DOCUMENTATION".to_string(),
            documentation.clone(),
        );
    }
    environment
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_modes_spell_exactly_the_wire_values() {
        assert_eq!(DeliveryMode::Merge.as_str(), "merge");
        assert_eq!(DeliveryMode::PullRequest.as_str(), "pull-request");
        assert_eq!(DeliveryMode::parse("merge"), Some(DeliveryMode::Merge));
        assert_eq!(
            DeliveryMode::parse("pull-request"),
            Some(DeliveryMode::PullRequest)
        );
        assert_eq!(DeliveryMode::parse("pull_request"), None);
    }

    #[test]
    fn a_harness_source_checkout_is_pinned_to_merge() {
        let saved = DeliveryMode::PullRequest;
        assert_eq!(
            effective(saved, ProjectKind::HarnessSource),
            DeliveryMode::Merge
        );
        assert_eq!(effective(saved, ProjectKind::Host), saved);
    }
}

/* ------------------------------------------------------------------------ */
/* The forge seam the delivery and maintenance paths read                    */
/* ------------------------------------------------------------------------ */

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

pub type DeliveryFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// One pull request as the forge reports it now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PullSnapshot {
    pub number: u64,
    pub url: String,
    /// `open`, `merged`, or `closed`.
    pub state: String,
    pub draft: bool,
    pub head: String,
    /// `mergeable`, `conflicting`, or `unknown`.
    pub mergeable: String,
}

/// One check the forge reports for the head commit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckObservation {
    pub name: String,
    /// `success`, `neutral`, `skipped`, `failure`, `pending`, or `unknown`.
    pub state: String,
    pub detail: Option<String>,
}

impl CheckObservation {
    fn passed(&self) -> bool {
        matches!(self.state.as_str(), "success" | "neutral" | "skipped")
    }
    fn failed(&self) -> bool {
        matches!(
            self.state.as_str(),
            "failure" | "cancelled" | "timed_out" | "action_required"
        )
    }
}

/// One review comment or review body the maintenance run answers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReviewComment {
    pub id: u64,
    pub body: String,
    pub author: String,
}

/// One ready pull request to create.
#[derive(Clone, Debug)]
pub struct CreatePull {
    pub cwd: PathBuf,
    pub head: String,
    pub base: String,
    pub title: String,
    pub body: String,
}

/// What one maintenance run asks its agent for.
#[derive(Clone, Debug)]
pub struct MaintenanceInput {
    pub repo_dir: PathBuf,
    pub worktree: PathBuf,
    pub record: MaintenanceRecord,
    pub conflicting: bool,
    pub failing_checks: Vec<CheckObservation>,
    pub comments: Vec<ReviewComment>,
    pub state_dir: PathBuf,
}

/// One comment's outcome.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommentDecision {
    pub comment_id: u64,
    /// The reply, bounded to 600 bytes by the worker. Absent leaves the thread
    /// unanswered and unresolved.
    pub reply: Option<String>,
    /// True for a comment the agent implemented or explicitly refused.
    pub resolved: bool,
}

/// What one maintenance agent did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MaintenanceResult {
    pub changed: bool,
    pub decisions: Vec<CommentDecision>,
    pub addressed_check: Option<String>,
}

pub type MaintainFn = Arc<
    dyn Fn(MaintenanceInput) -> DeliveryFuture<'static, Result<MaintenanceResult, String>>
        + Send
        + Sync,
>;

/// The forge operations delivery and maintenance need. The production adapter
/// drives `gh` and the Gitea REST API; a deterministic fake drives the tests.
pub trait DeliveryForge: Send + Sync {
    fn create_ready<'a>(
        &'a self,
        input: CreatePull,
    ) -> DeliveryFuture<'a, Result<PullSnapshot, String>>;
    fn view<'a>(&'a self, number: u64) -> DeliveryFuture<'a, Result<PullSnapshot, String>>;
    fn checks<'a>(
        &'a self,
        number: u64,
        base: &'a str,
    ) -> DeliveryFuture<'a, Result<Vec<CheckObservation>, String>>;
    fn review_comments<'a>(
        &'a self,
        number: u64,
    ) -> DeliveryFuture<'a, Result<Vec<ReviewComment>, String>>;
    fn reply<'a>(
        &'a self,
        number: u64,
        comment: u64,
        body: &'a str,
    ) -> DeliveryFuture<'a, Result<(), String>>;
    fn resolve_thread<'a>(
        &'a self,
        number: u64,
        comment: u64,
    ) -> DeliveryFuture<'a, Result<(), String>>;
    fn find_open_by_head<'a>(
        &'a self,
        head: &'a str,
    ) -> DeliveryFuture<'a, Result<Option<PullSnapshot>, String>>;
    fn issue_open<'a>(&'a self, number: u64) -> DeliveryFuture<'a, Result<bool, String>>;
    fn close_issue<'a>(&'a self, number: u64) -> DeliveryFuture<'a, Result<(), String>>;
}

/* ------------------------------------------------------------------------ */
/* The production adapter                                                    */
/* ------------------------------------------------------------------------ */

fn forge_environment(environment: &HashMap<String, String>) -> HashMap<String, String> {
    let mut result: HashMap<String, String> = std::env::vars().collect();
    result.extend(environment.clone());
    result
}

fn first_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default()
        .to_string()
}

fn forge_failure(operation: &str, stdout: &str, stderr: &str, code: i32) -> String {
    let detail = first_line(stderr);
    let detail = if detail.is_empty() {
        first_line(stdout)
    } else {
        detail
    };
    if detail.is_empty() {
        format!("Could not {operation}: exit code {code}")
    } else {
        format!("Could not {operation}: {detail}")
    }
}

fn number_from_url(url: &str) -> Option<u64> {
    let trimmed = url.trim().trim_end_matches('/');
    let tail = trimmed.rsplit('/').next()?;
    tail.parse().ok()
}

fn first_url(text: &str) -> Option<String> {
    text.split_whitespace()
        .find(|word| word.starts_with("https://") || word.starts_with("http://"))
        .map(|word| word.trim_end_matches([',', ')', '}']).to_string())
}

/// The production adapter: `gh` for GitHub and the Gitea REST API.
pub struct CommandDeliveryForge {
    repo_dir: PathBuf,
    environment: HashMap<String, String>,
    remote: crate::forge::ForgeRemote,
    transport: crate::forge::Transport,
    timeout_ms: u64,
}

impl CommandDeliveryForge {
    pub fn new(repo_dir: &Path, environment: HashMap<String, String>) -> Result<Self, String> {
        let Some(remote) = crate::forge::origin_forge_with(repo_dir, &environment) else {
            return Err(
                crate::forge::origin_problem(repo_dir, &environment).unwrap_or_else(|| {
                    "the checkout's origin does not name a supported repository".to_string()
                }),
            );
        };
        if remote.forge == crate::forge::Forge::GitLab {
            return Err(
                "the issues console supports a GitHub or Gitea origin, not a GitLab one"
                    .to_string(),
            );
        }
        Ok(Self {
            repo_dir: repo_dir.to_path_buf(),
            environment,
            remote,
            transport: crate::forge::default_transport(crate::forge::GITEA_REQUEST_TIMEOUT_MS),
            timeout_ms: crate::forge::GITEA_REQUEST_TIMEOUT_MS,
        })
    }

    fn is_gitea(&self) -> bool {
        self.remote.forge == crate::forge::Forge::Gitea
    }

    fn project(&self) -> String {
        self.remote.project.clone()
    }

    fn gitea_target(&self) -> Result<crate::forge::GiteaTarget, String> {
        let base_url = crate::forge::gitea_base_url(Some(&self.remote), &self.environment)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                "the Gitea address is not configured (set DEVBOARD_GITEA_URL)".to_string()
            })?;
        let token = crate::forge::configured_gitea_token(&self.environment)
            .ok_or_else(|| "GITEA_TOKEN is not set".to_string())?;
        Ok(crate::forge::GiteaTarget {
            base_url,
            project: self.project(),
            token: Some(token),
        })
    }

    fn call_options(&self) -> crate::forge::GiteaCallOptions {
        crate::forge::GiteaCallOptions {
            flow_id: None,
            timeout_ms: Some(self.timeout_ms),
        }
    }

    async fn gh_outcome(
        &self,
        args: Vec<String>,
        body: Option<String>,
    ) -> crate::forge::ExecResult {
        let mut environment = forge_environment(&self.environment);
        environment.insert("GH_PROMPT_DISABLED".into(), "1".into());
        environment.insert("GH_NO_UPDATE_NOTIFIER".into(), "1".into());
        environment.insert("GIT_TERMINAL_PROMPT".into(), "0".into());
        let exec = crate::forge::default_exec();
        exec(
            "gh".to_string(),
            args,
            crate::forge::ExecOptions {
                cwd: Some(self.repo_dir.clone()),
                env: environment,
                timeout_ms: Some(self.timeout_ms),
                stdin: body,
            },
        )
        .await
    }

    async fn gh(&self, args: Vec<String>, body: Option<String>) -> Result<String, String> {
        let outcome = self.gh_outcome(args, body).await;
        if outcome.code != 0 {
            return Err(forge_failure(
                "run gh",
                &outcome.stdout,
                &outcome.stderr,
                outcome.code,
            ));
        }
        Ok(outcome.stdout)
    }

    async fn gitea_json(&self, path: &str) -> Result<Value, String> {
        let target = self.gitea_target()?;
        crate::forge::gitea_json(
            &target,
            &format!("{}/{}", crate::forge::repo_path(&target), path),
            None,
            &self.transport,
            &self.call_options(),
        )
        .await
        .map_err(|error| error.message)
    }

    async fn gitea_write(
        &self,
        path: &str,
        init: crate::forge::GiteaRequestInit,
    ) -> Result<Value, String> {
        let target = self.gitea_target()?;
        crate::forge::gitea_json(
            &target,
            &format!("{}/{}", crate::forge::repo_path(&target), path),
            Some(init),
            &self.transport,
            &self.call_options(),
        )
        .await
        .map_err(|error| error.message)
    }
}

fn github_snapshot(value: &Value, fallback_number: u64, fallback_url: &str) -> PullSnapshot {
    let number = value
        .get("number")
        .and_then(Value::as_u64)
        .unwrap_or(fallback_number);
    let url = value
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or(fallback_url)
        .to_string();
    let state = match value.get("state").and_then(Value::as_str) {
        Some("MERGED") => "merged",
        Some("CLOSED") => "closed",
        _ => "open",
    }
    .to_string();
    let mergeable = match value.get("mergeable").and_then(Value::as_str) {
        Some("CONFLICTING") => "conflicting",
        Some("MERGEABLE") => "mergeable",
        _ => match value.get("mergeStateStatus").and_then(Value::as_str) {
            Some("DIRTY") => "conflicting",
            Some("CLEAN") | Some("HAS_HOOKS") | Some("UNSTABLE") => "mergeable",
            _ => "unknown",
        },
    }
    .to_string();
    PullSnapshot {
        number,
        url,
        state,
        draft: value.get("isDraft").and_then(Value::as_bool) == Some(true),
        head: value
            .get("headRefOid")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        mergeable,
    }
}

fn github_check_state(state: &str) -> String {
    match state.to_ascii_lowercase().as_str() {
        "success" | "pass" | "passed" => "success",
        "neutral" => "neutral",
        "skipped" | "skipping" => "skipped",
        "failure" | "fail" | "failed" => "failure",
        "cancelled" | "cancel" => "cancelled",
        "timed_out" | "timed out" => "timed_out",
        "action_required" | "action required" => "action_required",
        "pending" | "queued" | "in_progress" | "in progress" | "waiting" => "pending",
        _ => "unknown",
    }
    .to_string()
}

impl DeliveryForge for CommandDeliveryForge {
    fn create_ready<'a>(
        &'a self,
        input: CreatePull,
    ) -> DeliveryFuture<'a, Result<PullSnapshot, String>> {
        Box::pin(async move {
            if self.is_gitea() {
                let target = self.gitea_target()?;
                let pull = crate::forge::gitea_create_pull_ready(
                    &target,
                    &crate::forge::CreatePullInput {
                        head: input.head.clone(),
                        base: input.base.clone(),
                        title: input.title.clone(),
                        body: input.body.clone(),
                    },
                    &self.transport,
                    &self.call_options(),
                )
                .await
                .map_err(|error| error.message)?;
                let head = input.head.clone();
                return Ok(PullSnapshot {
                    number: pull.number.max(0) as u64,
                    url: pull.url,
                    state: "open".into(),
                    draft: false,
                    head,
                    mergeable: "unknown".into(),
                });
            }
            let output = self
                .gh(
                    vec![
                        "pr".to_string(),
                        "create".to_string(),
                        "--base".to_string(),
                        input.base.clone(),
                        "--head".to_string(),
                        input.head.clone(),
                        "--title".to_string(),
                        input.title.clone(),
                        "--body".to_string(),
                        input.body.clone(),
                    ],
                    None,
                )
                .await?;
            let Some(url) = first_url(&output) else {
                return Err(
                    "Could not create the pull request: the forge returned no URL.".to_string(),
                );
            };
            let Some(number) = number_from_url(&url) else {
                return Err(
                    "Could not create the pull request: the forge returned no number.".to_string(),
                );
            };
            Ok(PullSnapshot {
                number,
                url,
                state: "open".into(),
                draft: false,
                head: input.head,
                mergeable: "unknown".into(),
            })
        })
    }

    fn view<'a>(&'a self, number: u64) -> DeliveryFuture<'a, Result<PullSnapshot, String>> {
        Box::pin(async move {
            if self.is_gitea() {
                let document = self.gitea_json(&format!("pulls/{number}")).await?;
                let pull = crate::forge::gitea_pull(
                    &self.gitea_target()?,
                    number as i64,
                    &self.transport,
                    &self.call_options(),
                )
                .await
                .map_err(|error| error.message)?;
                let state = pull.state.as_str().to_string();
                let head = document
                    .pointer("/head/sha")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let mergeable = if document.get("mergeable").and_then(Value::as_bool) == Some(false)
                {
                    "conflicting"
                } else if document.get("mergeable").and_then(Value::as_bool) == Some(true) {
                    "mergeable"
                } else {
                    "unknown"
                };
                return Ok(PullSnapshot {
                    number,
                    url: pull.url,
                    state,
                    draft: pull.draft,
                    head,
                    mergeable: mergeable.to_string(),
                });
            }
            let output = self
                .gh(
                    vec![
                        "pr".to_string(),
                        "view".to_string(),
                        number.to_string(),
                        "--json".to_string(),
                        "number,url,state,isDraft,headRefOid,mergeable,mergeStateStatus"
                            .to_string(),
                    ],
                    None,
                )
                .await?;
            let value: Value = serde_json::from_str(&output).map_err(|_| {
                "Could not read the pull request: unexpected forge output.".to_string()
            })?;
            Ok(github_snapshot(&value, number, ""))
        })
    }

    fn checks<'a>(
        &'a self,
        number: u64,
        base: &'a str,
    ) -> DeliveryFuture<'a, Result<Vec<CheckObservation>, String>> {
        Box::pin(async move {
            if self.is_gitea() {
                let snapshot = self.view(number).await?;
                if snapshot.head.is_empty() {
                    return Ok(Vec::new());
                }
                let document = self
                    .gitea_json(&format!("commits/{}/statuses", snapshot.head))
                    .await?;
                let rows = document.as_array().cloned().unwrap_or_default();
                return Ok(rows
                    .iter()
                    .map(|row| {
                        let name = row
                            .get("context")
                            .and_then(Value::as_str)
                            .or_else(|| row.get("description").and_then(Value::as_str))
                            .unwrap_or("status");
                        let state = row
                            .get("state")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown");
                        CheckObservation {
                            name: name.to_string(),
                            state: github_check_state(state),
                            detail: row
                                .get("target_url")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                        }
                    })
                    .collect());
            }
            // The forge's required list, when branch protection exposes one.
            let mut required: Vec<String> = Vec::new();
            let project = self.project();
            if let Ok(output) = self
                .gh(
                    vec![
                        "api".to_string(),
                        format!("repos/{project}/branches/{base}/protection"),
                        "--jq".to_string(),
                        ".required_status_checks.contexts // [] | .[]".to_string(),
                    ],
                    None,
                )
                .await
            {
                required = output
                    .lines()
                    .map(|line| line.trim().to_string())
                    .filter(|line| !line.is_empty())
                    .collect();
            }
            // `gh pr checks` exits nonzero for failing and pending checks while
            // still printing the JSON rows, so its status is not the read's
            // verdict; only an empty answer with a nonzero status is.
            let outcome = self
                .gh_outcome(
                    vec![
                        "pr".to_string(),
                        "checks".to_string(),
                        number.to_string(),
                        "--json".to_string(),
                        "name,state,bucket,link".to_string(),
                    ],
                    None,
                )
                .await;
            let output = if outcome.stdout.trim().is_empty() && outcome.code != 0 {
                return Err(forge_failure(
                    "read the pull request checks",
                    &outcome.stdout,
                    &outcome.stderr,
                    outcome.code,
                ));
            } else {
                outcome.stdout
            };
            let rows: Value = serde_json::from_str(&output).unwrap_or(Value::Array(Vec::new()));
            let mut checks = Vec::new();
            for row in rows.as_array().cloned().unwrap_or_default() {
                let name = row.get("name").and_then(Value::as_str).unwrap_or("check");
                if !required.is_empty() && !required.iter().any(|required| required == name) {
                    continue;
                }
                let state = row
                    .get("bucket")
                    .and_then(Value::as_str)
                    .or_else(|| row.get("state").and_then(Value::as_str))
                    .unwrap_or("unknown");
                checks.push(CheckObservation {
                    name: name.to_string(),
                    state: github_check_state(state),
                    detail: row.get("link").and_then(Value::as_str).map(str::to_string),
                });
            }
            Ok(checks)
        })
    }

    fn review_comments<'a>(
        &'a self,
        number: u64,
    ) -> DeliveryFuture<'a, Result<Vec<ReviewComment>, String>> {
        Box::pin(async move {
            let project = self.project();
            let mut comments = Vec::new();
            if self.is_gitea() {
                let pulls = self.gitea_json(&format!("pulls/{number}/reviews")).await?;
                for row in pulls.as_array().cloned().unwrap_or_default() {
                    let Some(id) = row.get("id").and_then(Value::as_u64) else {
                        continue;
                    };
                    let body = row.get("body").and_then(Value::as_str).unwrap_or("").trim();
                    if body.is_empty() {
                        continue;
                    }
                    comments.push(ReviewComment {
                        id,
                        body: body.to_string(),
                        author: row
                            .pointer("/user/login")
                            .and_then(Value::as_str)
                            .unwrap_or("reviewer")
                            .to_string(),
                    });
                }
            } else {
                for (path, author_key) in [
                    (format!("repos/{project}/pulls/{number}/comments"), "user"),
                    (format!("repos/{project}/pulls/{number}/reviews"), "user"),
                ] {
                    let output = self
                        .gh(
                            vec![
                                "api".to_string(),
                                path,
                                "--paginate".to_string(),
                                "-q".to_string(),
                                ".[] | {id: .id, body: .body, author: .user.login}".to_string(),
                            ],
                            None,
                        )
                        .await?;
                    for line in output.lines() {
                        let Ok(row) = serde_json::from_str::<Value>(line) else {
                            continue;
                        };
                        let Some(id) = row.get("id").and_then(Value::as_u64) else {
                            continue;
                        };
                        let body = row.get("body").and_then(Value::as_str).unwrap_or("").trim();
                        if body.is_empty() {
                            continue;
                        }
                        comments.push(ReviewComment {
                            id,
                            body: body.to_string(),
                            author: row
                                .get("author")
                                .and_then(Value::as_str)
                                .unwrap_or(author_key)
                                .to_string(),
                        });
                    }
                }
            }
            comments.sort_by_key(|comment| comment.id);
            comments.dedup_by_key(|comment| comment.id);
            Ok(comments)
        })
    }

    fn reply<'a>(
        &'a self,
        number: u64,
        comment: u64,
        body: &'a str,
    ) -> DeliveryFuture<'a, Result<(), String>> {
        Box::pin(async move {
            if self.is_gitea() {
                // Gitea has no per-review reply endpoint; a PR comment names the
                // review it answers so the thread stays attributable.
                let text = format!("> Re #{comment}\n\n{body}");
                self.gitea_write(
                    &format!("issues/{number}/comments"),
                    crate::forge::GiteaRequestInit::post(
                        serde_json::to_vec(&json!({"body": text})).unwrap_or_default(),
                    ),
                )
                .await?;
                return Ok(());
            }
            let project = self.project();
            let payload = json!({"body": body}).to_string();
            self.gh(
                vec![
                    "api".to_string(),
                    "--method".to_string(),
                    "POST".to_string(),
                    format!("repos/{project}/pulls/{number}/comments/{comment}/replies"),
                    "--input".to_string(),
                    "-".to_string(),
                ],
                Some(payload),
            )
            .await?;
            Ok(())
        })
    }

    fn resolve_thread<'a>(
        &'a self,
        number: u64,
        comment: u64,
    ) -> DeliveryFuture<'a, Result<(), String>> {
        Box::pin(async move {
            if self.is_gitea() {
                // Gitea's nearest equivalent is dismissing the review that
                // raised the comment; the state is reported, never guessed.
                let _ = self
                    .gitea_write(
                        &format!("pulls/{number}/reviews/{comment}/dismissals"),
                        crate::forge::GiteaRequestInit::post(
                            serde_json::to_vec(&json!({"message": "Addressed by the agent."}))
                                .unwrap_or_default(),
                        ),
                    )
                    .await;
                return Ok(());
            }
            let project = self.project();
            let (owner, name) = project
                .split_once('/')
                .ok_or_else(|| format!("The origin repository {project} is not owner/name."))?;
            let query = r#"query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id comments(first:1){nodes{databaseId}}}}}}}"#;
            let output = self
                .gh(
                    vec![
                        "api".to_string(),
                        "graphql".to_string(),
                        "-f".to_string(),
                        format!("query={query}"),
                        "-f".to_string(),
                        format!("owner={owner}"),
                        "-f".to_string(),
                        format!("name={name}"),
                        "-F".to_string(),
                        format!("number={number}"),
                    ],
                    None,
                )
                .await?;
            let value: Value = serde_json::from_str(&output).unwrap_or(Value::Null);
            let thread = value
                .pointer("/data/repository/pullRequest/reviewThreads/nodes")
                .and_then(Value::as_array)
                .and_then(|nodes| {
                    nodes.iter().find(|node| {
                        node.pointer("/comments/nodes/0/databaseId")
                            .and_then(Value::as_u64)
                            == Some(comment)
                    })
                })
                .and_then(|node| node.get("id"))
                .and_then(Value::as_str);
            let Some(thread) = thread else {
                return Ok(());
            };
            let mutation = r#"mutation($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{isResolved}}}"#;
            self.gh(
                vec![
                    "api".to_string(),
                    "graphql".to_string(),
                    "-f".to_string(),
                    format!("query={mutation}"),
                    "-f".to_string(),
                    format!("thread={thread}"),
                ],
                None,
            )
            .await?;
            Ok(())
        })
    }

    fn find_open_by_head<'a>(
        &'a self,
        head: &'a str,
    ) -> DeliveryFuture<'a, Result<Option<PullSnapshot>, String>> {
        Box::pin(async move {
            if self.is_gitea() {
                let document = self.gitea_json("pulls?state=open&limit=50").await?;
                let rows = document.as_array().cloned().unwrap_or_default();
                for row in rows {
                    if row.pointer("/head/ref").and_then(Value::as_str) == Some(head) {
                        let number = row.get("number").and_then(Value::as_u64).unwrap_or(0);
                        if number > 0 {
                            return Ok(Some(self.view(number).await?));
                        }
                    }
                }
                return Ok(None);
            }
            let project = self.project();
            let output = self
                .gh(
                    vec![
                        "pr".to_string(),
                        "list".to_string(),
                        "--repo".to_string(),
                        project,
                        "--state".to_string(),
                        "open".to_string(),
                        "--head".to_string(),
                        head.to_string(),
                        "--json".to_string(),
                        "number,url,state,isDraft,headRefOid,mergeable,mergeStateStatus"
                            .to_string(),
                    ],
                    None,
                )
                .await?;
            let rows: Value = serde_json::from_str(&output).unwrap_or(Value::Array(Vec::new()));
            let Some(row) = rows.as_array().and_then(|rows| rows.first()) else {
                return Ok(None);
            };
            Ok(Some(github_snapshot(row, 0, "")))
        })
    }

    fn issue_open<'a>(&'a self, number: u64) -> DeliveryFuture<'a, Result<bool, String>> {
        Box::pin(async move {
            if self.is_gitea() {
                let project = self.project();
                let document = self.gitea_json(&format!("issues/{number}")).await?;
                let _ = project;
                return Ok(document.get("state").and_then(Value::as_str) != Some("closed"));
            }
            let project = self.project();
            let output = self
                .gh(
                    vec![
                        "api".to_string(),
                        format!("repos/{project}/issues/{number}"),
                        "--jq".to_string(),
                        ".state".to_string(),
                    ],
                    None,
                )
                .await?;
            Ok(output.trim() != "closed")
        })
    }

    fn close_issue<'a>(&'a self, number: u64) -> DeliveryFuture<'a, Result<(), String>> {
        Box::pin(async move {
            if self.is_gitea() {
                let target = self.gitea_target()?;
                crate::forge::gitea_close_issue(
                    &target,
                    number as i64,
                    &self.transport,
                    &self.call_options(),
                )
                .await
                .map(|_| ())
                .map_err(|error| error.message)
            } else {
                let project = self.project();
                self.gh(
                    vec![
                        "api".to_string(),
                        "--method".to_string(),
                        "PATCH".to_string(),
                        format!("repos/{project}/issues/{number}"),
                        "-f".to_string(),
                        "state=closed".to_string(),
                    ],
                    None,
                )
                .await
                .map(|_| ())
            }
        })
    }
}

/// Builds the production forge for one checkout.
pub fn create_forge(
    repo_dir: &Path,
    environment: &HashMap<String, String>,
) -> Result<Arc<dyn DeliveryForge>, String> {
    Ok(Arc::new(CommandDeliveryForge::new(
        repo_dir,
        environment.clone(),
    )?))
}

/* ------------------------------------------------------------------------ */
/* Git delivery                                                              */
/* ------------------------------------------------------------------------ */

fn git_output(directory: &Path, args: &[&str]) -> Result<String, String> {
    let outcome = crate::forge::git(directory, args);
    if outcome.code != 0 {
        let detail = first_line(&outcome.stderr);
        let detail = if detail.is_empty() {
            first_line(&outcome.stdout)
        } else {
            detail
        };
        return Err(format!(
            "Could not run git {}: {}",
            args.join(" "),
            if detail.is_empty() {
                format!("exit code {}", outcome.code)
            } else {
                detail
            }
        ));
    }
    Ok(outcome.stdout.trim().to_string())
}

fn integration_branch(repo_dir: &Path) -> Result<String, String> {
    git_output(repo_dir, &["symbolic-ref", "--short", "HEAD"]).or_else(|_| Ok("main".to_string()))
}

/// The record that makes the worker maintain a pull request the forge already
/// holds. A write that fails is reported with the request it names, because the
/// request exists and keeps needing maintenance.
fn record_delivery(
    delivered: &DeliveredPullRequest,
    written: std::io::Result<Vec<MaintenanceRecord>>,
) -> Result<(), String> {
    written.map(|_| ()).map_err(|error| {
        format!(
            "pull request #{} ({}) was delivered but its maintenance record could not be written: {error}",
            delivered.number, delivered.url
        )
    })
}

/// Delivers one issue's local commits as a pushed branch and one ready pull
/// request. The integration branch is left at `base_tip`; nothing is force
/// pushed.
pub async fn deliver_issue_change(
    repo_dir: &Path,
    state_dir: &Path,
    forge: &dyn DeliveryForge,
    issue: &crate::issues_mode::Issue,
    run_id: &str,
    base_tip: &str,
) -> Result<DeliveredPullRequest, String> {
    if let Some(record) = open_record_for_issue(state_dir, repo_dir, issue.number) {
        return Ok(record.pull_request);
    }
    let head = git_output(repo_dir, &["rev-parse", "HEAD"])?;
    if head == base_tip {
        return Err(format!(
            "the agent produced no commit for issue #{}; the pull request needs one",
            issue.number
        ));
    }
    let base = integration_branch(repo_dir)?;
    let branch = fresh_issue_branch(state_dir, repo_dir, issue.number, run_id);
    let reset = |repo_dir: &Path| {
        let _ = git_output(repo_dir, &["reset", "--hard", base_tip]);
    };
    // The prompt asks the agent to push the branch and open the request; when
    // it already did, the worker adopts that one instead of opening a second.
    if let Some(existing) = forge.find_open_by_head(&branch).await? {
        reset(repo_dir);
        let delivered = DeliveredPullRequest {
            number: existing.number,
            url: existing.url,
            state: existing.state,
            branch,
            base,
            head,
        };
        let mut record = MaintenanceRecord::new(delivered.clone(), Some(issue.number), None);
        record.head_commit = delivered.head.clone();
        record_delivery(&delivered, upsert_maintenance(state_dir, repo_dir, record))?;
        return Ok(delivered);
    }
    if let Err(detail) = git_output(
        repo_dir,
        &["push", "origin", &format!("{head}:refs/heads/{branch}")],
    ) {
        reset(repo_dir);
        return Err(format!("Could not push the branch {branch}: {detail}"));
    }
    let title = format!("#{} {}", issue.number, issue.title.trim());
    let body = format!(
        "{}\n\nImplemented by Devboard for issue #{}.\n",
        closing_keyword(issue.number),
        issue.number
    );
    let snapshot = match forge
        .create_ready(CreatePull {
            cwd: repo_dir.to_path_buf(),
            head: branch.clone(),
            base: base.clone(),
            title,
            body,
        })
        .await
    {
        Ok(snapshot) => snapshot,
        Err(detail) => {
            reset(repo_dir);
            return Err(format!("Could not open the pull request: {detail}"));
        }
    };
    reset(repo_dir);
    let delivered = DeliveredPullRequest {
        number: snapshot.number,
        url: snapshot.url,
        state: snapshot.state,
        branch,
        base,
        head: head.clone(),
    };
    let mut record = MaintenanceRecord::new(delivered.clone(), Some(issue.number), None);
    record.head_commit = head;
    record_delivery(&delivered, upsert_maintenance(state_dir, repo_dir, record))?;
    Ok(delivered)
}

/// Pushes one already-committed documentation worktree as a branch and opens
/// one ready pull request against `base`, recording it for maintenance.
pub async fn deliver_branch(
    cwd: &Path,
    repo_dir: &Path,
    state_dir: &Path,
    forge: &dyn DeliveryForge,
    branch: &str,
    base: &str,
    title: String,
    body: String,
    head: &str,
    issue: Option<u64>,
    documentation: Option<String>,
) -> Result<DeliveredPullRequest, String> {
    git_output(
        cwd,
        &["push", "origin", &format!("{head}:refs/heads/{branch}")],
    )
    .map_err(|detail| format!("Could not push the branch {branch}: {detail}"))?;
    let snapshot = forge
        .create_ready(CreatePull {
            cwd: cwd.to_path_buf(),
            head: branch.to_string(),
            base: base.to_string(),
            title,
            body,
        })
        .await
        .map_err(|detail| format!("Could not open the pull request: {detail}"))?;
    let delivered = DeliveredPullRequest {
        number: snapshot.number,
        url: snapshot.url,
        state: snapshot.state,
        branch: branch.to_string(),
        base: base.to_string(),
        head: head.to_string(),
    };
    let mut record = MaintenanceRecord::new(delivered.clone(), issue, documentation);
    record.head_commit = head.to_string();
    record_delivery(&delivered, upsert_maintenance(state_dir, repo_dir, record))?;
    Ok(delivered)
}

/* ------------------------------------------------------------------------ */
/* Maintenance planning and one cycle                                        */
/* ------------------------------------------------------------------------ */

/// What one due check does for one pull request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MaintenanceAction {
    /// Nothing changed: no agent starts, and a green mergeable request is
    /// simply left for the operator to merge.
    None,
    /// The forge reports the request merged.
    Merged,
    /// The forge reports the request closed without merging.
    Closed,
    /// One maintenance run is due, named by the reason it started.
    Run { reason: String },
}

/// The required checks above `checks` that a fix run must address.
pub fn failing_checks(checks: &[CheckObservation]) -> Vec<CheckObservation> {
    checks
        .iter()
        .filter(|check| check.failed())
        .cloned()
        .collect()
}

/// The check state one observation reports, in the maintenance record's
/// vocabulary.
pub fn check_state(checks: &[CheckObservation]) -> String {
    if checks.iter().any(CheckObservation::failed) {
        "failed".to_string()
    } else if checks.iter().any(|check| !check.passed()) {
        "pending".to_string()
    } else {
        "green".to_string()
    }
}

/// Decides whether one due check starts a maintenance run.
pub fn plan_maintenance(
    record: &MaintenanceRecord,
    snapshot: &PullSnapshot,
    checks: &[CheckObservation],
    comments: &[ReviewComment],
) -> MaintenanceAction {
    if snapshot.state == "merged" {
        return MaintenanceAction::Merged;
    }
    if snapshot.state == "closed" {
        return MaintenanceAction::Closed;
    }
    let new_comments = comments
        .iter()
        .any(|comment| Some(comment.id) > record.last_handled_comment);
    if new_comments {
        return MaintenanceAction::Run {
            reason: "new review comment".to_string(),
        };
    }
    let failing = failing_checks(checks);
    if let Some(check) = failing.first() {
        return MaintenanceAction::Run {
            reason: format!("required check {} failed", check.name),
        };
    }
    if snapshot.mergeable == "conflicting" {
        return MaintenanceAction::Run {
            reason: "the pull request conflicts with its base".to_string(),
        };
    }
    MaintenanceAction::None
}

/// Where one pull request's maintenance worktree lives.
pub fn maintenance_worktree(repo_dir: &Path, number: u64) -> PathBuf {
    repo_dir
        .join(".worktree")
        .join(format!("pull-request-{number}"))
}

fn ensure_maintenance_worktree(
    repo_dir: &Path,
    record: &MaintenanceRecord,
) -> Result<PathBuf, String> {
    let directory = maintenance_worktree(repo_dir, record.pull_request.number);
    if directory.join(".git").exists() {
        return Ok(directory);
    }
    let branch = &record.pull_request.branch;
    git_output(repo_dir, &["fetch", "origin", branch])?;
    if let Some(parent) = directory.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::remove_dir_all(&directory);
    git_output(
        repo_dir,
        &[
            "worktree",
            "add",
            "--detach",
            &directory.display().to_string(),
            &format!("origin/{branch}"),
        ],
    )?;
    Ok(directory)
}

fn pending_merge(directory: &Path) -> bool {
    directory.join(".git").exists()
        && git_output(directory, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_ok()
}

fn unmerged_paths(directory: &Path) -> Vec<String> {
    git_output(directory, &["diff", "--name-only", "--diff-filter=U"])
        .map(|text| {
            text.lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Cuts one reply to the 600-byte budget without splitting a character.
pub fn bounded_reply(text: &str) -> String {
    const LIMIT: usize = 600;
    if text.len() <= LIMIT {
        return text.to_string();
    }
    let mut cut = LIMIT;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    text[..cut].trim_end().to_string()
}

/// The run id one maintenance entry carries.
fn maintenance_run_id(record: &MaintenanceRecord, at_millis: i64) -> String {
    format!("pull-request-{}-{at_millis}", record.pull_request.number)
}

/// Writes one maintenance run into the existing Issues run history.
pub fn record_maintenance_run(
    state_dir: &Path,
    repo_dir: &Path,
    record: &MaintenanceRecord,
    status: &str,
    detail: &str,
) -> Result<PathBuf, String> {
    let now = crate::journal::now_iso8601();
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    let run_id = maintenance_run_id(record, millis);
    let directory = state_dir
        .join("issues")
        .join(crate::journal::repo_key(repo_dir))
        .join("runs")
        .join(&run_id);
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("could not create the maintenance run directory: {error}"))?;
    let issues = record
        .issue
        .map(|number| {
            vec![crate::issues_mode::Issue {
                number,
                title: format!("pull request #{}", record.pull_request.number),
                url: record.pull_request.url.clone(),
                created_at: now.clone(),
                labels: Vec::new(),
                body: Some(detail.to_string()),
            }]
        })
        .unwrap_or_default();
    let run = crate::issues_mode::RunFile {
        version: 1,
        run_id: run_id.clone(),
        repo: repo_dir.display().to_string(),
        status: status.to_string(),
        argv: vec!["devboard".to_string(), "pull-request".to_string()],
        cwd: repo_dir.display().to_string(),
        started_at: now.clone(),
        finished_at: Some(now),
        exit_code: Some(if status == "succeeded" { 0 } else { 1 }),
        issues,
        first_stderr_line: (status != "succeeded").then(|| detail.to_string()),
        worker_pid: std::process::id(),
        start_ticks: crate::supervision::start_ticks(std::process::id()),
        harness_version: crate::version::read_harness_version(
            &crate::version::running_harness_dir(),
        ),
        pull_request: Some(record.pull_request.json()),
    };
    crate::issues_mode::write_run_file(&directory, &run)
        .map_err(|error| format!("could not write the maintenance run: {error}"))?;
    Ok(directory)
}

/// The outcome of one due maintenance check.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MaintenanceOutcome {
    NoChange,
    Merged,
    Closed,
    Ran {
        reason: String,
        head_changed: bool,
        addressed_check: Option<String>,
    },
}

/// One due maintenance check for one agent-opened pull request.
///
/// A terminal request closes or requeues its issue and starts no agent. An
/// unchanged request starts none. Everything else starts exactly one
/// maintenance agent, then applies its replies and its pushed commit.
pub async fn run_maintenance(
    repo_dir: &Path,
    state_dir: &Path,
    record: MaintenanceRecord,
    forge: &dyn DeliveryForge,
    maintain: Option<&MaintainFn>,
) -> Result<MaintenanceOutcome, String> {
    let snapshot = forge.view(record.pull_request.number).await?;
    match snapshot.state.as_str() {
        "merged" => {
            if let Some(issue) = record.issue {
                if forge.issue_open(issue).await.unwrap_or(false) {
                    forge.close_issue(issue).await?;
                }
            }
            let mut updated = record.clone();
            updated.state = "merged".to_string();
            updated.pull_request.state = "merged".to_string();
            updated.head_commit = snapshot.head.clone();
            let mut records = read_maintenance(state_dir, repo_dir);
            if let Some(existing) = records.iter_mut().find(|entry| entry.id == updated.id) {
                *existing = updated.clone();
            } else {
                records.push(updated.clone());
            }
            write_maintenance(state_dir, repo_dir, &records)
                .map_err(|error| format!("could not write the maintenance record: {error}"))?;
            let _ = record_maintenance_run(
                state_dir,
                repo_dir,
                &updated,
                "succeeded",
                "the pull request merged; the issue is closed",
            );
            return Ok(MaintenanceOutcome::Merged);
        }
        "closed" => {
            let mut updated = record.clone();
            updated.state = "closed".to_string();
            updated.pull_request.state = "closed".to_string();
            let mut records = read_maintenance(state_dir, repo_dir);
            if let Some(existing) = records.iter_mut().find(|entry| entry.id == updated.id) {
                *existing = updated.clone();
            } else {
                records.push(updated.clone());
            }
            write_maintenance(state_dir, repo_dir, &records)
                .map_err(|error| format!("could not write the maintenance record: {error}"))?;
            let _ = record_maintenance_run(
                state_dir,
                repo_dir,
                &updated,
                "succeeded",
                "the pull request closed unmerged; the issue returns to the queue",
            );
            return Ok(MaintenanceOutcome::Closed);
        }
        _ => {}
    }
    let checks = forge
        .checks(record.pull_request.number, &record.pull_request.base)
        .await?;
    let comments = forge.review_comments(record.pull_request.number).await?;
    let action = plan_maintenance(&record, &snapshot, &checks, &comments);
    let reason = match action {
        MaintenanceAction::None => {
            let mut updated = record.clone();
            updated.head_commit = snapshot.head.clone();
            updated.check_state = check_state(&checks);
            updated.mergeable_state = snapshot.mergeable.clone();
            if updated != record {
                let mut records = read_maintenance(state_dir, repo_dir);
                if let Some(existing) = records.iter_mut().find(|entry| entry.id == updated.id) {
                    *existing = updated;
                } else {
                    records.push(updated);
                }
                write_maintenance(state_dir, repo_dir, &records)
                    .map_err(|error| format!("could not write the maintenance record: {error}"))?;
            }
            return Ok(MaintenanceOutcome::NoChange);
        }
        MaintenanceAction::Merged => return Ok(MaintenanceOutcome::Merged),
        MaintenanceAction::Closed => return Ok(MaintenanceOutcome::Closed),
        MaintenanceAction::Run { reason } => reason,
    };
    let Some(maintain) = maintain else {
        return Err(format!(
            "pull request #{} needs maintenance ({reason}) but no maintenance peer is configured",
            record.pull_request.number
        ));
    };
    let worktree = ensure_maintenance_worktree(repo_dir, &record)?;
    let conflicting = snapshot.mergeable == "conflicting";
    if conflicting {
        let base = record.pull_request.base.clone();
        git_output(&worktree, &["fetch", "origin", &base])?;
        let merge = crate::forge::git(
            &worktree,
            &["merge", "--no-edit", &format!("origin/{base}")],
        );
        if merge.code != 0 && unmerged_paths(&worktree).is_empty() {
            return Err(format!(
                "Could not integrate origin/{base} into the pull request: {}",
                first_line(&merge.stderr)
            ));
        }
    }
    let new_comments: Vec<ReviewComment> = comments
        .iter()
        .filter(|comment| Some(comment.id) > record.last_handled_comment)
        .cloned()
        .collect();
    let failing = failing_checks(&checks);
    let result = maintain(MaintenanceInput {
        repo_dir: repo_dir.to_path_buf(),
        worktree: worktree.clone(),
        record: record.clone(),
        conflicting,
        failing_checks: failing,
        comments: new_comments.clone(),
        state_dir: state_dir.to_path_buf(),
    })
    .await?;
    if pending_merge(&worktree) {
        let remaining = unmerged_paths(&worktree);
        if !remaining.is_empty() {
            return Err(format!(
                "the maintenance run left conflicts unresolved: {}",
                remaining.join(", ")
            ));
        }
        git_output(&worktree, &["add", "-A"])?;
        git_output(&worktree, &["commit", "--no-edit"])?;
    }
    let head = git_output(&worktree, &["rev-parse", "HEAD"])?;
    let head_changed = head != record.head_commit;
    if head_changed {
        if git_output(
            &worktree,
            &["merge-base", "--is-ancestor", &record.head_commit, &head],
        )
        .is_err()
        {
            return Err(format!(
                "the maintenance run rewrote the published branch {}; a push was refused",
                record.pull_request.branch
            ));
        }
        git_output(
            &worktree,
            &[
                "push",
                "origin",
                &format!("HEAD:refs/heads/{}", record.pull_request.branch),
            ],
        )
        .map_err(|detail| {
            format!(
                "Could not push the branch {}: {detail}",
                record.pull_request.branch
            )
        })?;
    }
    // A reply is posted once, then its thread is resolved when the agent
    // implemented or explicitly refused the comment. A comment with no reply
    // stays unanswered and unresolved.
    let mut last_handled = record.last_handled_comment;
    let mut resolve_error: Option<String> = None;
    for comment in &new_comments {
        let decision = result
            .decisions
            .iter()
            .find(|decision| decision.comment_id == comment.id);
        let Some(decision) = decision else {
            break;
        };
        let Some(reply) = decision
            .reply
            .as_deref()
            .map(str::trim)
            .filter(|reply| !reply.is_empty())
        else {
            break;
        };
        let reply = bounded_reply(reply);
        forge
            .reply(record.pull_request.number, comment.id, &reply)
            .await?;
        // The reply is posted; the record advances even if the thread's
        // resolution fails, so a later run never repeats it.
        last_handled = Some(comment.id);
        if decision.resolved {
            if let Err(detail) = forge
                .resolve_thread(record.pull_request.number, comment.id)
                .await
            {
                resolve_error.get_or_insert(detail);
            }
        }
    }
    let mut updated = record.clone();
    updated.head_commit = head;
    updated.last_handled_comment = last_handled;
    updated.check_state = match &result.addressed_check {
        Some(_) => "green".to_string(),
        None => check_state(&checks),
    };
    updated.mergeable_state = snapshot.mergeable.clone();
    let mut records = read_maintenance(state_dir, repo_dir);
    if let Some(existing) = records.iter_mut().find(|entry| entry.id == updated.id) {
        *existing = updated.clone();
    } else {
        records.push(updated.clone());
    }
    write_maintenance(state_dir, repo_dir, &records)
        .map_err(|error| format!("could not write the maintenance record: {error}"))?;
    let _ = record_maintenance_run(
        state_dir,
        repo_dir,
        &updated,
        "succeeded",
        &format!(
            "maintained pull request #{} for {}: {reason}",
            record.pull_request.number,
            record
                .issue
                .map(|issue| format!("issue #{issue}"))
                .or_else(|| record.documentation.clone())
                .unwrap_or_else(|| "the documentation".to_string())
        ),
    );
    if let Some(detail) = resolve_error {
        return Err(format!("Could not resolve the review thread: {detail}"));
    }
    Ok(MaintenanceOutcome::Ran {
        reason,
        head_changed,
        addressed_check: result.addressed_check,
    })
}

/* ------------------------------------------------------------------------ */
/* Production maintenance peer                                               */
/* ------------------------------------------------------------------------ */

/// Runs one maintenance agent: the request document names the pull request,
/// its branch and worktree, the failing checks, and the unanswered comments;
/// the agent writes `result.json` beside it.
pub fn production_maintainer(
    agent_command: &str,
    environment: HashMap<String, String>,
) -> MaintainFn {
    let command = agent_command.to_string();
    let environment = environment.clone();
    Arc::new(move |input: MaintenanceInput| {
        let command = command.clone();
        let environment = environment.clone();
        Box::pin(async move { run_maintenance_peer(command, environment, input).await })
    })
}

async fn run_maintenance_peer(
    agent_command: String,
    environment: HashMap<String, String>,
    input: MaintenanceInput,
) -> Result<MaintenanceResult, String> {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    let directory = input
        .state_dir
        .join("delivery")
        .join(crate::journal::repo_key(&input.repo_dir))
        .join("maintenance-runs")
        .join(format!("pr-{}-{millis}", input.record.pull_request.number));
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("could not create {}: {error}", directory.display()))?;
    let request = json!({
        "version": 1,
        "pullRequest": input.record.pull_request.json(),
        "issue": input.record.issue,
        "documentation": input.record.documentation,
        "headCommit": input.record.head_commit,
        "lastHandledComment": input.record.last_handled_comment,
        "branch": input.record.pull_request.branch,
        "base": input.record.pull_request.base,
        "worktree": input.worktree.display().to_string(),
        "conflicting": input.conflicting,
        "failingChecks": input.failing_checks.iter().map(|check| json!({
            "name": check.name,
            "state": check.state,
            "detail": check.detail,
        })).collect::<Vec<_>>(),
        "comments": input.comments.iter().map(|comment| json!({
            "id": comment.id,
            "author": comment.author,
            "body": comment.body,
        })).collect::<Vec<_>>(),
    });
    let text = crate::jsjson::stringify(&request);
    std::fs::write(directory.join("request.json"), format!("{text}\n"))
        .map_err(|error| format!("could not write the maintenance request: {error}"))?;
    let options =
        crate::acp::AcpConnectionOptions::new(agent_command, input.worktree.display().to_string())
            .with_starter("Issues")
            .with_env(environment);
    let (peer, _events) = crate::acp::AcpConnection::connect(options)
        .await
        .map_err(|error| error.message)?;
    let instructions = concat!(
        "Maintain one agent-opened pull request. Read the request document once; it names the ",
        "pull request, the branch, the base, the worktree, the failing required checks, and the ",
        "unanswered review comments. Work only in the named worktree. Never merge the pull ",
        "request, never force-push, and never rewrite a published commit. When a required check ",
        "failed, read its failing job and step from the check detail, change the implementation, ",
        "run the change's checks, and commit the fix. When the request conflicts with its base, ",
        "integrate the base in the worktree and resolve every conflict. For each new review ",
        "comment answer once and briefly with at most 600 bytes in `reply`; mark `resolved` true ",
        "when you implemented it or explicitly refused it with one concrete safety or correctness ",
        "reason, and leave `reply` null and `resolved` false when you cannot answer it. Write ",
        "`result.json` beside the request as {\"changed\":bool,\"addressedCheck\":string|null,",
        "\"comments\":[{\"id\":number,\"reply\":string|null,\"resolved\":bool}]}. Commit every ",
        "implementation change in the worktree; the worker pushes it once."
    );
    let prompt = format!(
        "{instructions}\n\nRequest directory: {}",
        directory.display()
    );
    peer.run(&prompt).await.map_err(|error| error.message)?;
    peer.close();
    let result = std::fs::read_to_string(directory.join("result.json"))
        .map_err(|error| format!("the maintenance agent wrote no result: {error}"))?;
    let value: Value = serde_json::from_str(&result)
        .map_err(|error| format!("the maintenance result is not JSON: {error}"))?;
    let decisions = value
        .get("comments")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    Some(CommentDecision {
                        comment_id: row.get("id")?.as_u64()?,
                        reply: row.get("reply").and_then(Value::as_str).map(str::to_string),
                        resolved: row
                            .get("resolved")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(MaintenanceResult {
        changed: value
            .get("changed")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        decisions,
        addressed_check: value
            .get("addressedCheck")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}
