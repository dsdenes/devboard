//! Goal run: the lifecycle, its lanes, manual ADR runs, and the reset.
//!
//! Ported from `.devboard/server/app.ts`: one lifecycle loop owns the epic
//! generation pass, one lane per open epic, and one lane per pending ADR. A
//! manual sequence resolves pending records in order, pausing an advancing
//! lifecycle so both never write the same record. The durable state keys are
//! `lifecycle`, `lastLifecycle`, `lifecycleRunning`, `lanes`, `epicStates`,
//! `parkedEpics`, `knownEpics`, `manualRun`, and `resetActive`, among others,
//! so a replacement continues exactly where its predecessor stopped.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, OnceLock, Weak};
use std::time::Duration;

use serde_json::{json, Map, Value};
use tokio::sync::{mpsc, Notify};

use crate::acp::{
    AcpActivity, AcpConnection, AcpConnectionOptions, AcpEvent, AcpId, AcpQuestion,
    PermissionPolicy,
};
use crate::app::{App, Conn, ModeGate, StateSection};
use crate::command::Command;
use crate::forge::{
    self, Environment, Exec, ExecOptions, Forge, IssueQueryState, RequiredAccess, ResolveOptions,
};
use crate::state::{ACTIVITY_MAX_BYTES, ACTIVITY_MAX_ENTRIES, ACTIVITY_TRIMMED_MARKER};

const EPIC_PROMPT: &str = "/epic-next";
const IMPLEMENT_PROMPT: &str = "/implement-next-epic";
/// The title the interface shows for a generation lane.
const EPIC_GENERATION_TITLE: &str = "Epic generation";
/// Marker a peer prints on its own line when it cannot finish its work.
const BLOCKER_MARKER: &str = "DEVBOARD-BLOCKED:";
/// Total tracker reads per settle, including the first.
const TRACKER_SETTLE_ATTEMPTS: usize = 7;
const TRACKER_SETTLE_DELAY_MS: u64 = 500;
const LANE_BACKOFF_MS: u64 = 5_000;
const LANE_RETENTION_MS: u64 = 30_000;
const MAIN_POLL_MS: u64 = 2_000;
const TRACKER_READ_TIMEOUT_MS: u64 = 30_000;
const GIT_TIMEOUT_MS: u64 = 60_000;
/// Top-level entries an implementation reset keeps.
const RESET_KEEP_NAMES: [&str; 5] = [".devboard", ".omp", "AGENTS.md", ".gitignore", "GOAL.md"];
/// Repository internals a reset preserves without committing them.
const RESET_INTERNAL_NAMES: [&str; 2] = [".git", ".worktree"];
/// Paths a reset never stages, even without a `.gitignore`.
const RESET_STAGE_EXCLUSIONS: [&str; 3] = [".worktree", ".devboard/node_modules", ".devboard/dist"];
const RESET_STATE_EXCLUDE_COMMENT: &str = "# Devboard state directory";
const RESET_COMMIT_MESSAGE: &str = "chore: reset implementation";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// The stage the lifecycle reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    Goal,
    Epic,
    Adr,
    Implementation,
    Finished,
}

impl Stage {
    fn as_str(self) -> &'static str {
        match self {
            Self::Goal => "goal",
            Self::Epic => "epic",
            Self::Adr => "adr",
            Self::Implementation => "implementation",
            Self::Finished => "finished",
        }
    }

    fn parse(value: Option<&Value>) -> Option<Self> {
        match value?.as_str()? {
            "goal" => Some(Self::Goal),
            "epic" => Some(Self::Epic),
            "adr" => Some(Self::Adr),
            "implementation" => Some(Self::Implementation),
            "finished" => Some(Self::Finished),
            _ => None,
        }
    }
}

/// One stage's work reference.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Work {
    kind: WorkKind,
    id: String,
    url: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WorkKind {
    Adr,
    Epic,
}

impl Work {
    fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert(
            "kind".into(),
            json!(match self.kind {
                WorkKind::Adr => "adr",
                WorkKind::Epic => "epic",
            }),
        );
        object.insert("id".into(), json!(self.id));
        if let Some(url) = &self.url {
            object.insert("url".into(), json!(url));
        }
        Value::Object(object)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Lifecycle {
    stage: Stage,
    pass: u64,
    work: Option<Work>,
    paused: bool,
}

impl Lifecycle {
    fn idle(pass: u64) -> Self {
        Self {
            stage: Stage::Goal,
            pass,
            work: None,
            paused: false,
        }
    }

    fn to_json(&self) -> Value {
        json!({
            "stage": self.stage.as_str(),
            "pass": self.pass,
            "work": self.work.as_ref().map(Work::to_json),
            "paused": self.paused,
        })
    }

    fn same_shape(&self, other: &Lifecycle) -> bool {
        self.stage == other.stage
            && self.pass == other.pass
            && self.paused == other.paused
            && self.work == other.work
    }
}

/// One open epic the tracker reported.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Epic {
    number: i64,
    title: String,
    url: String,
}

impl Epic {
    fn id(&self) -> String {
        self.number.to_string()
    }

    fn to_json(&self) -> Value {
        json!({"number": self.number, "title": self.title, "url": self.url})
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LaneKind {
    Generation,
    Implementation,
    Adr,
}

impl LaneKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Generation => "generation",
            Self::Implementation => "implementation",
            Self::Adr => "adr",
        }
    }

    fn parse(value: Option<&Value>) -> Option<Self> {
        match value?.as_str()? {
            "generation" => Some(Self::Generation),
            "implementation" => Some(Self::Implementation),
            "adr" => Some(Self::Adr),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LaneStatus {
    Running,
    Paused,
    Closed,
    Failed,
    Retrying,
    Parked,
}

impl LaneStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Closed => "closed",
            Self::Failed => "failed",
            Self::Retrying => "retrying",
            Self::Parked => "parked",
        }
    }

    fn parse(value: Option<&Value>) -> Option<Self> {
        match value?.as_str()? {
            "running" => Some(Self::Running),
            "paused" => Some(Self::Paused),
            "closed" => Some(Self::Closed),
            "failed" => Some(Self::Failed),
            "retrying" => Some(Self::Retrying),
            "parked" => Some(Self::Parked),
            _ => None,
        }
    }

    fn live(self) -> bool {
        matches!(self, Self::Running | Self::Paused)
    }

    fn retained(self) -> bool {
        matches!(self, Self::Closed | Self::Failed)
    }
}

/// One ADR record a lane resolves.
#[derive(Clone, Debug, PartialEq, Eq)]
struct RecordRef {
    file: String,
    title: String,
}

impl RecordRef {
    fn to_json(&self) -> Value {
        json!({"file": self.file, "title": self.title})
    }
}

/// A question the interface shows and answers.
#[derive(Clone, Debug, PartialEq)]
struct RunQuestion {
    id: Value,
    message: String,
    options: Vec<Value>,
}

impl RunQuestion {
    fn key(&self) -> String {
        match &self.id {
            Value::String(text) => text.clone(),
            Value::Number(number) => number.to_string(),
            other => other.to_string(),
        }
    }

    fn to_json(&self) -> Value {
        json!({"id": self.id, "message": self.message, "options": self.options})
    }
}

/// One agent peer in a lifecycle run. Every lane owns exactly one unit of
/// work: an epic generation pass, one open epic, or one ADR record.
struct Lane {
    id: String,
    kind: LaneKind,
    epic: Mutex<Option<Epic>>,
    record: Option<RecordRef>,
    attempt: u64,
    status: Mutex<LaneStatus>,
    activity: Mutex<Vec<String>>,
    question: Mutex<Option<RunQuestion>>,
    agent: Mutex<Option<Arc<AcpConnection>>>,
    blocked: AtomicBool,
    failure: Mutex<Option<String>>,
    retainer: Mutex<Option<u64>>,
    retention_scheduled: AtomicBool,
}

impl Lane {
    fn new(
        id: String,
        kind: LaneKind,
        epic: Option<Epic>,
        record: Option<RecordRef>,
        attempt: u64,
        status: LaneStatus,
    ) -> Self {
        Self {
            id,
            kind,
            epic: Mutex::new(epic),
            record,
            attempt,
            status: Mutex::new(status),
            activity: Mutex::new(Vec::new()),
            question: Mutex::new(None),
            agent: Mutex::new(None),
            blocked: AtomicBool::new(false),
            failure: Mutex::new(None),
            retainer: Mutex::new(None),
            retention_scheduled: AtomicBool::new(false),
        }
    }

    fn title(&self) -> String {
        if self.kind == LaneKind::Generation {
            return EPIC_GENERATION_TITLE.to_string();
        }
        if let Some(record) = &self.record {
            return record.title.clone();
        }
        lock(&self.epic)
            .as_ref()
            .map(|epic| epic.title.clone())
            .unwrap_or_default()
    }

    fn action(&self) -> &'static str {
        match self.kind {
            LaneKind::Generation => "generating",
            LaneKind::Adr => "resolving",
            LaneKind::Implementation => "implementing",
        }
    }

    fn status(&self) -> LaneStatus {
        *lock(&self.status)
    }

    fn set_status(&self, status: LaneStatus) {
        *lock(&self.status) = status;
    }

    fn close_peer(&self) {
        let agent = lock(&self.agent).take();
        if let Some(agent) = agent {
            agent.close();
        }
    }

    fn activity(&self) -> Vec<String> {
        lock(&self.activity).clone()
    }

    fn question(&self) -> Option<RunQuestion> {
        lock(&self.question).clone()
    }

    fn failure(&self) -> Option<String> {
        lock(&self.failure).clone()
    }

    fn snapshot(&self) -> Value {
        let epic = lock(&self.epic).clone();
        let status = self.status();
        json!({
            "id": self.id,
            "kind": self.kind.as_str(),
            "epic": epic.as_ref().map(Epic::to_json),
            "record": self.record.as_ref().map(RecordRef::to_json),
            "attempt": self.attempt,
            "status": status.as_str(),
            "activity": self.activity(),
            "question": self.question().map(|question| question.to_json()),
        })
    }

    fn stored(&self) -> Value {
        let mut object = Map::new();
        object.insert("id".into(), json!(self.id));
        object.insert("kind".into(), json!(self.kind.as_str()));
        object.insert(
            "epic".into(),
            lock(&self.epic)
                .as_ref()
                .map(Epic::to_json)
                .unwrap_or(Value::Null),
        );
        object.insert(
            "record".into(),
            self.record
                .as_ref()
                .map(RecordRef::to_json)
                .unwrap_or(Value::Null),
        );
        object.insert("attempt".into(), json!(self.attempt));
        object.insert("status".into(), json!(self.status().as_str()));
        object.insert("activity".into(), json!(self.activity()));
        object.insert(
            "question".into(),
            self.question()
                .map(|question| question.to_json())
                .unwrap_or(Value::Null),
        );
        object.insert("blocked".into(), json!(self.blocked.load(Ordering::SeqCst)));
        object.insert(
            "failure".into(),
            self.failure().map(Value::String).unwrap_or(Value::Null),
        );
        object.insert(
            "retainUntil".into(),
            lock(&self.retainer)
                .map(|until| json!(until))
                .unwrap_or(Value::Null),
        );
        Value::Object(object)
    }
}

/// The lifecycle's memory of one open epic across its attempts.
struct EpicState {
    epic: Epic,
    attempts: u64,
    status: EpicStatus,
    main_at_failure: Option<String>,
    retry_scheduled: bool,
    retry_token: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EpicStatus {
    Running,
    Retrying,
    Parked,
    Closed,
}

impl EpicStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Retrying => "retrying",
            Self::Parked => "parked",
            Self::Closed => "closed",
        }
    }

    fn parse(value: Option<&Value>) -> Option<Self> {
        match value?.as_str()? {
            "running" => Some(Self::Running),
            "retrying" => Some(Self::Retrying),
            "parked" => Some(Self::Parked),
            "closed" => Some(Self::Closed),
            _ => None,
        }
    }
}

/// A manual ADR resolution sequence's current run.
struct ManualRun {
    file: String,
    title: String,
    action: String,
    activity: Mutex<Vec<String>>,
    question: Mutex<Option<RunQuestion>>,
    agent: Mutex<Option<Arc<AcpConnection>>>,
}

impl ManualRun {
    fn new(file: String, title: String) -> Self {
        Self {
            file,
            title,
            action: "resolving".to_string(),
            activity: Mutex::new(Vec::new()),
            question: Mutex::new(None),
            agent: Mutex::new(None),
        }
    }

    fn activity(&self) -> Vec<String> {
        lock(&self.activity).clone()
    }

    fn question(&self) -> Option<RunQuestion> {
        lock(&self.question).clone()
    }

    fn close_peer(&self) {
        let agent = lock(&self.agent).take();
        if let Some(agent) = agent {
            agent.close();
        }
    }

    fn stored(&self) -> Value {
        json!({
            "file": self.file,
            "title": self.title,
            "action": self.action,
            "activity": self.activity(),
            "question": self.question()
                .map(|question| question.to_json())
                .unwrap_or(Value::Null),
        })
    }
}

/// A manual run's terminal state. The interface opens no socket, so a
/// stopped broadcast reaches no page: the polled `/goal` read replays this
/// instead, and a page that missed the end learns it on its next poll.
struct FinishedManualRun {
    file: String,
    title: String,
    activity: Vec<String>,
    resolved: bool,
    status: String,
}

fn finished_manual_run(run: &ManualRun, resolved: bool, status: &str) -> Arc<FinishedManualRun> {
    Arc::new(FinishedManualRun {
        file: run.file.clone(),
        title: run.title.clone(),
        activity: run.activity(),
        resolved,
        status: status.to_string(),
    })
}

/// Every mutable field this mode owns.
struct Inner {
    lifecycle: Lifecycle,
    last_lifecycle: Option<Lifecycle>,
    lifecycle_running: bool,
    lifecycle_paused_for_manual_run: bool,
    lane_sequence: u64,
    lanes: Vec<Arc<Lane>>,
    live: HashMap<String, Arc<Lane>>,
    epic_states: BTreeMap<String, EpicState>,
    parked_epics: BTreeSet<String>,
    known_epics: Vec<Epic>,
    generation_active: bool,
    generation_queued: bool,
    generation_attempted: bool,
    manual_run: Option<Arc<ManualRun>>,
    last_manual_run: Option<Arc<FinishedManualRun>>,
    manual_sequencing: bool,
    resume_after_manual_sequence: bool,
    manual_start_request: u64,
    lifecycle_start_request: u64,
    reset_active: bool,
    restored_paused_lifecycle: bool,
    unwinding: bool,
    lane_epoch: u64,
    main_polling: bool,
    main_watcher: Option<tokio::task::JoinHandle<()>>,
    startup_notices: Vec<Value>,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            lifecycle: Lifecycle::idle(1),
            last_lifecycle: None,
            lifecycle_running: false,
            lifecycle_paused_for_manual_run: false,
            lane_sequence: 0,
            lanes: Vec::new(),
            live: HashMap::new(),
            epic_states: BTreeMap::new(),
            parked_epics: BTreeSet::new(),
            known_epics: Vec::new(),
            generation_active: false,
            generation_queued: false,
            generation_attempted: false,
            manual_run: None,
            last_manual_run: None,
            manual_sequencing: false,
            resume_after_manual_sequence: false,
            manual_start_request: 0,
            lifecycle_start_request: 0,
            reset_active: false,
            restored_paused_lifecycle: false,
            unwinding: false,
            lane_epoch: 0,
            main_polling: false,
            main_watcher: None,
            startup_notices: Vec::new(),
        }
    }
}

/// The mode itself, reached from every durable section and command.
struct GoalRun {
    app: OnceLock<Weak<App>>,
    inner: Mutex<Inner>,
    wake: Notify,
    resume: Notify,
    tracker_abort: Notify,
    unwound: Notify,
    generation_gate: tokio::sync::Mutex<()>,
    resume_scheduled: AtomicBool,
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/// Registers this mode's durable state with the dashboard.
pub fn init(app: &Arc<App>) {
    let owner = Arc::new(GoalRun {
        app: OnceLock::new(),
        inner: Mutex::new(Inner::default()),
        wake: Notify::new(),
        resume: Notify::new(),
        tracker_abort: Notify::new(),
        unwound: Notify::new(),
        generation_gate: tokio::sync::Mutex::new(()),
        resume_scheduled: AtomicBool::new(false),
    });
    let _ = owner.app.set(Arc::downgrade(app));
    for (key, field) in [
        ("lifecycle", Field::Lifecycle),
        ("lastLifecycle", Field::LastLifecycle),
        ("lifecycleRunning", Field::Running),
        ("lifecyclePausedForManualRun", Field::PausedForManualRun),
        ("laneSequence", Field::LaneSequence),
        ("lanes", Field::Lanes),
        ("epicStates", Field::EpicStates),
        ("parkedEpics", Field::ParkedEpics),
        ("knownEpics", Field::KnownEpics),
        ("generationQueued", Field::GenerationQueued),
        ("generationAttempted", Field::GenerationAttempted),
        ("manualSequencing", Field::ManualSequencing),
        ("manualRun", Field::ManualRun),
        ("resetActive", Field::ResetActive),
    ] {
        app.shared.register_section(
            key,
            Arc::new(Section {
                owner: Arc::clone(&owner),
                field,
            }),
        );
    }
    app.shared.register_gate(
        "goal-run",
        Arc::new(GoalRunGate {
            owner: Arc::downgrade(&owner),
        }),
    );
    let mut registry = lock(registry());
    registry.retain(|_, weak| weak.strong_count() > 0);
    registry.insert(
        app.shared.state_path().to_path_buf(),
        Arc::downgrade(&owner),
    );
}

/// What other modes ask this one before starting work.
struct GoalRunGate {
    owner: Weak<GoalRun>,
}

impl ModeGate for GoalRunGate {
    fn has_active_work(&self) -> bool {
        let Some(owner) = self.owner.upgrade() else {
            return false;
        };
        let inner = lock(&owner.inner);
        inner.reset_active
            || inner.lifecycle_running
            || !inner.live.is_empty()
            || inner.manual_run.is_some()
            || inner.manual_sequencing
            || inner.generation_active
            || inner.generation_queued
    }

    fn busy_reason(&self) -> Option<String> {
        let owner = self.owner.upgrade()?;
        let inner = lock(&owner.inner);
        if inner.reset_active {
            Some("An implementation reset is active.".to_string())
        } else if inner.lifecycle_running {
            Some("The lifecycle is active.".to_string())
        } else if inner.manual_run.is_some() || inner.manual_sequencing {
            Some("A manual ADR run is active.".to_string())
        } else {
            None
        }
    }

    fn abort_active_work(&self) {
        let Some(owner) = self.owner.upgrade() else {
            return;
        };
        let Some(app) = owner.app.get().and_then(Weak::upgrade) else {
            return;
        };
        owner.abort_goal_work_after_lock(&app);
    }

    fn paused(&self) -> bool {
        let Some(owner) = self.owner.upgrade() else {
            return false;
        };
        let inner = lock(&owner.inner);
        inner.lifecycle_running && inner.lifecycle.paused
    }
}

/// Sets the reset flag for a test seam. Production only reaches this through
/// `perform_implementation_reset`.
#[doc(hidden)]
pub fn set_reset_active(app: &Arc<App>, active: bool) {
    if let Some(owner) = state_for(app) {
        lock(&owner.inner).reset_active = active;
    }
}

/// True while an implementation reset is under way. Every non-read-only
/// command is refused in that window.
pub fn reset_is_active(app: &Arc<App>) -> bool {
    state_for(app)
        .map(|owner| lock(&owner.inner).reset_active)
        .unwrap_or(false)
}

/// Replays the frames a connecting client owes before its own replies.
pub fn replay(app: &Arc<App>, conn: &Conn) {
    let Some(this) = state_for(app) else {
        return;
    };
    let (notices, reset, replayed, manual, finished, lanes) = {
        let mut inner = lock(&this.inner);
        let notices = std::mem::take(&mut inner.startup_notices);
        let replayed = if inner.lifecycle_running {
            Some(inner.lifecycle.clone())
        } else {
            inner
                .last_lifecycle
                .clone()
                .or_else(|| (inner.lifecycle.pass > 1).then(|| inner.lifecycle.clone()))
        };
        let lanes =
            if !inner.lanes.is_empty() || inner.lifecycle_running || inner.last_lifecycle.is_some()
            {
                Some(lane_snapshot(&inner))
            } else {
                None
            };
        let manual = inner.manual_run.as_ref().map(ManualView::from);
        // A sequence between runs owns no manual run, so its last terminal
        // frame would report a stop the sequence has not reached.
        let finished = if manual.is_none() && !inner.manual_sequencing {
            inner.last_manual_run.clone()
        } else {
            None
        };
        (
            notices,
            inner.reset_active,
            replayed,
            manual,
            finished,
            lanes,
        )
    };
    for notice in notices {
        conn.send(notice);
    }
    if reset {
        conn.send(json!({"type": "implementationResetStarted"}));
    }
    if let Some(lifecycle) = replayed {
        conn.send(json!({"type": "lifecycleState",
            "stage": lifecycle.stage.as_str(),
            "pass": lifecycle.pass,
            "work": lifecycle.work.as_ref().map(Work::to_json),
            "paused": lifecycle.paused,
        }));
    }
    if let Some(manual) = manual {
        send_run_conversation(conn, &manual);
    } else if let Some(finished) = finished {
        send_finished_run(conn, &finished);
    }
    if let Some(lanes) = lanes {
        conn.send(lanes);
    }
}

/// Applies one command; `false` when it belongs to another mode.
pub async fn handle(app: &Arc<App>, conn: &Conn, command: &Command) -> bool {
    let Some(this) = state_for(app) else {
        return false;
    };
    match command {
        Command::StartLifecycle => {
            this.start_lifecycle(app, &Target::Conn(conn.clone())).await;
            true
        }
        Command::StopLifecycle => {
            this.stop_lifecycle(app, &Target::Conn(conn.clone()));
            true
        }
        Command::PauseLifecycle => {
            this.pause_lifecycle(&Target::Conn(conn.clone()));
            true
        }
        Command::ResumeLifecycle => {
            this.resume_lifecycle(app, &Target::Conn(conn.clone()))
                .await;
            true
        }
        Command::StartRun { file } => {
            this.start_run(app, &Target::Conn(conn.clone()), file.as_ref())
                .await;
            true
        }
        Command::ResetImplementation => {
            this.start_implementation_reset(app, &Target::Conn(conn.clone()));
            true
        }
        Command::Answer { id, value, lane } => {
            this.answer_question(app, conn, id.as_ref(), value.as_ref(), lane.as_ref())
        }
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Durable state
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
enum Field {
    Lifecycle,
    LastLifecycle,
    Running,
    PausedForManualRun,
    LaneSequence,
    Lanes,
    EpicStates,
    ParkedEpics,
    KnownEpics,
    GenerationQueued,
    GenerationAttempted,
    ManualSequencing,
    ManualRun,
    ResetActive,
}

struct Section {
    owner: Arc<GoalRun>,
    field: Field,
}

impl StateSection for Section {
    fn snapshot(&self) -> Option<Value> {
        Some(self.owner.snapshot_field(self.field))
    }

    fn restore(&self, value: &Value) {
        self.owner.restore_field(self.field, value);
        self.owner.schedule_resume();
    }
}

static REGISTRY: LazyLock<Mutex<HashMap<PathBuf, Weak<GoalRun>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn registry() -> &'static Mutex<HashMap<PathBuf, Weak<GoalRun>>> {
    &REGISTRY
}

fn state_for(app: &Arc<App>) -> Option<Arc<GoalRun>> {
    lock(registry())
        .get(app.shared.state_path())
        .and_then(Weak::upgrade)
}

impl GoalRun {
    fn snapshot_field(&self, field: Field) -> Value {
        let inner = lock(&self.inner);
        match field {
            Field::Lifecycle => inner.lifecycle.to_json(),
            Field::LastLifecycle => inner
                .last_lifecycle
                .as_ref()
                .map(Lifecycle::to_json)
                .unwrap_or(Value::Null),
            Field::Running => json!(inner.lifecycle_running),
            Field::PausedForManualRun => json!(inner.lifecycle_paused_for_manual_run),
            Field::LaneSequence => json!(inner.lane_sequence),
            Field::Lanes => Value::Array(inner.lanes.iter().map(|lane| lane.stored()).collect()),
            Field::EpicStates => Value::Array(
                inner
                    .epic_states
                    .iter()
                    .map(|(id, state)| {
                        json!({
                            "id": id,
                            "epic": state.epic.to_json(),
                            "attempts": state.attempts,
                            "status": state.status.as_str(),
                            "mainAtFailure": state.main_at_failure,
                        })
                    })
                    .collect(),
            ),
            Field::ParkedEpics => json!(inner.parked_epics.iter().cloned().collect::<Vec<_>>()),
            Field::KnownEpics => {
                Value::Array(inner.known_epics.iter().map(Epic::to_json).collect())
            }
            Field::GenerationQueued => json!(inner.generation_queued),
            Field::GenerationAttempted => json!(inner.generation_attempted),
            Field::ManualSequencing => json!(inner.manual_sequencing),
            Field::ManualRun => inner
                .manual_run
                .as_ref()
                .map(|run| run.stored())
                .unwrap_or(Value::Null),
            Field::ResetActive => json!(inner.reset_active),
        }
    }

    fn restore_field(&self, field: Field, value: &Value) {
        let mut inner = lock(&self.inner);
        match field {
            Field::Lifecycle => {
                if let Some(lifecycle) = parse_lifecycle(value) {
                    inner.lifecycle = lifecycle;
                }
            }
            Field::LastLifecycle => {
                inner.last_lifecycle = parse_lifecycle(value);
            }
            Field::Running => {
                inner.lifecycle_running = value.as_bool() == Some(true);
            }
            Field::PausedForManualRun => {
                inner.lifecycle_paused_for_manual_run = value.as_bool() == Some(true);
            }
            Field::LaneSequence => {
                if let Some(number) = value.as_u64() {
                    inner.lane_sequence = number;
                }
            }
            Field::Lanes => {
                let Some(entries) = value.as_array() else {
                    return;
                };
                let mut lanes = Vec::new();
                let mut sequence = inner.lane_sequence;
                for entry in entries {
                    let Some(stored) = parse_stored_lane(entry) else {
                        continue;
                    };
                    if let Some(rest) = stored.id.strip_prefix("lane-") {
                        if let Ok(number) = rest.parse::<u64>() {
                            sequence = sequence.max(number);
                        }
                    }
                    lanes.push(stored);
                }
                inner.lane_sequence = sequence;
                let now = now_millis();
                let previous = std::mem::take(&mut inner.lanes);
                inner.live.clear();
                for stored in lanes {
                    let retained = stored.status.retained();
                    if retained && stored.retain_until.is_none_or(|until| until <= now) {
                        continue;
                    }
                    let lane = Arc::new(Lane::new(
                        stored.id.clone(),
                        stored.kind,
                        stored.epic,
                        stored.record,
                        stored.attempt,
                        stored.status,
                    ));
                    *lock(&lane.activity) = stored.activity;
                    *lock(&lane.question) = stored.question;
                    lane.blocked.store(stored.blocked, Ordering::SeqCst);
                    *lock(&lane.failure) = stored.failure;
                    *lock(&lane.retainer) = stored.retain_until;
                    if stored.status.live() {
                        inner.live.insert(lane.id.clone(), Arc::clone(&lane));
                    }
                    inner.lanes.push(lane);
                }
                drop(previous);
            }
            Field::EpicStates => {
                let Some(entries) = value.as_array() else {
                    return;
                };
                inner.epic_states.clear();
                for entry in entries {
                    let Some(state) = parse_epic_state(entry) else {
                        continue;
                    };
                    inner.epic_states.insert(state.0, state.1);
                }
            }
            Field::ParkedEpics => {
                let Some(entries) = value.as_array() else {
                    return;
                };
                inner.parked_epics = entries
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect();
            }
            Field::KnownEpics => {
                let Some(entries) = value.as_array() else {
                    return;
                };
                inner.known_epics = dedup_epics(
                    entries
                        .iter()
                        .filter_map(|entry| parse_epic(Some(entry)))
                        .collect(),
                );
            }
            Field::GenerationQueued => {
                inner.generation_queued = value.as_bool() == Some(true);
            }
            Field::GenerationAttempted => {
                inner.generation_attempted = value.as_bool() == Some(true);
            }
            Field::ManualSequencing => {
                inner.manual_sequencing = value.as_bool() == Some(true);
            }
            Field::ManualRun => {
                inner.manual_run = parse_manual_run(value).map(|stored| {
                    let run = ManualRun::new(stored.file, stored.title);
                    *lock(&run.activity) = stored.activity;
                    *lock(&run.question) = stored.question;
                    Arc::new(run)
                });
            }
            Field::ResetActive => {
                if value.as_bool() == Some(true) {
                    inner.startup_notices.push(json!({
                        "type": "error",
                        "message": "The implementation reset was interrupted when the server \
                    stopped, so it was not resumed.",
                    }));
                    inner
                        .startup_notices
                        .push(json!({"type": "implementationResetStopped", "completed": false}));
                    let pass = inner.lifecycle.pass;
                    inner.lanes.clear();
                    inner.live.clear();
                    inner.epic_states.clear();
                    inner.parked_epics.clear();
                    inner.known_epics.clear();
                    inner.manual_run = None;
                    inner.manual_sequencing = false;
                    inner.lifecycle_running = false;
                    inner.lifecycle = Lifecycle::idle(pass);
                    inner.last_lifecycle = Some(inner.lifecycle.clone());
                    inner.reset_active = false;
                }
            }
        }
    }

    /// Resumes the work a previous process left behind, after every section
    /// has restored.
    fn schedule_resume(self: &Arc<Self>) {
        if self.resume_scheduled.swap(true, Ordering::SeqCst) {
            return;
        }
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let this = Arc::clone(self);
        handle.spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let Some(app) = this.app.get().and_then(Weak::upgrade) else {
                return;
            };
            this.resume_restored(&app).await;
        });
    }

    async fn resume_restored(self: &Arc<Self>, app: &Arc<App>) {
        let (retained, resume_manual, resume_lifecycle) = {
            let mut inner = lock(&self.inner);
            let resume_manual = inner.manual_run.is_some() || inner.manual_sequencing;
            inner.restored_paused_lifecycle = inner.lifecycle_running && inner.lifecycle.paused;
            let resume_lifecycle = inner.lifecycle_running && !inner.restored_paused_lifecycle;
            if resume_lifecycle {
                for id in inner
                    .epic_states
                    .iter()
                    .filter(|(_, state)| state.status == EpicStatus::Retrying)
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>()
                {
                    self.schedule_retry_locked(&mut inner, &id);
                }
            }
            let retained: Vec<Arc<Lane>> = inner
                .lanes
                .iter()
                .filter(|lane| lane.status().retained())
                .cloned()
                .collect();
            (retained, resume_manual, resume_lifecycle)
        };
        for lane in retained {
            self.schedule_lane_removal(app, &lane);
        }
        if resume_manual {
            let this = Arc::clone(self);
            let app = Arc::clone(app);
            tokio::spawn(async move {
                this.resume_restored_manual_sequence(&app).await;
            });
            return;
        }
        if !resume_lifecycle {
            return;
        }
        let this = Arc::clone(self);
        let app = Arc::clone(app);
        tokio::spawn(async move {
            this.continue_restored_lifecycle(&app).await;
        });
    }
}

/// One lane's restored bytes.
struct StoredLane {
    id: String,
    kind: LaneKind,
    epic: Option<Epic>,
    record: Option<RecordRef>,
    attempt: u64,
    status: LaneStatus,
    activity: Vec<String>,
    question: Option<RunQuestion>,
    blocked: bool,
    failure: Option<String>,
    retain_until: Option<u64>,
}

struct StoredManualRun {
    file: String,
    title: String,
    activity: Vec<String>,
    question: Option<RunQuestion>,
}

fn parse_lifecycle(value: &Value) -> Option<Lifecycle> {
    let record = value.as_object()?;
    let stage = Stage::parse(record.get("stage"))?;
    let pass = record.get("pass").and_then(Value::as_u64).unwrap_or(1);
    let work = parse_work(record.get("work"));
    Some(Lifecycle {
        stage,
        pass,
        work,
        paused: record
            .get("paused")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn parse_work(value: Option<&Value>) -> Option<Work> {
    let record = value?.as_object()?;
    let kind = match record.get("kind")?.as_str()? {
        "adr" => WorkKind::Adr,
        "epic" => WorkKind::Epic,
        _ => return None,
    };
    let id = record.get("id")?.as_str()?.to_string();
    Some(Work {
        kind,
        id,
        url: record
            .get("url")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn parse_epic(value: Option<&Value>) -> Option<Epic> {
    let record = value?.as_object()?;
    let number = record.get("number")?.as_i64()?;
    let title = record.get("title")?.as_str()?.to_string();
    Some(Epic {
        number,
        title,
        url: record
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    })
}

fn parse_activity(value: Option<&Value>) -> Option<Vec<String>> {
    let values = value?.as_array()?;
    let mut lines: Vec<String> = values
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    trim_activity(&mut lines);
    Some(lines)
}

fn parse_question(value: Option<&Value>) -> Option<RunQuestion> {
    let record = value?.as_object()?;
    let id = record.get("id")?.clone();
    if !matches!(id, Value::String(_) | Value::Number(_)) {
        return None;
    }
    let message = record.get("message")?.as_str()?.to_string();
    let options = record
        .get("options")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Some(RunQuestion {
        id,
        message,
        options,
    })
}

fn parse_stored_lane(value: &Value) -> Option<StoredLane> {
    let record = value.as_object()?;
    let id = record.get("id")?.as_str()?.to_string();
    let kind = LaneKind::parse(record.get("kind"))?;
    let status = LaneStatus::parse(record.get("status"))?;
    let attempt = record.get("attempt")?.as_u64()?;
    let activity = parse_activity(record.get("activity"))?;
    let record_ref = record.get("record").and_then(|value| {
        let entry = value.as_object()?;
        Some(RecordRef {
            file: entry.get("file")?.as_str()?.to_string(),
            title: entry.get("title")?.as_str()?.to_string(),
        })
    });
    Some(StoredLane {
        id,
        kind,
        epic: parse_epic(record.get("epic")),
        record: record_ref,
        attempt,
        status,
        activity,
        question: parse_question(record.get("question")),
        blocked: record.get("blocked").and_then(Value::as_bool) == Some(true),
        failure: record
            .get("failure")
            .and_then(Value::as_str)
            .map(str::to_string),
        retain_until: record
            .get("retainUntil")
            .and_then(Value::as_u64)
            .filter(|_| record.get("retainUntil").and_then(Value::as_f64).is_some()),
    })
}

fn parse_epic_state(value: &Value) -> Option<(String, EpicState)> {
    let record = value.as_object()?;
    let id = record.get("id")?.as_str()?.to_string();
    let epic = parse_epic(record.get("epic"))?;
    let attempts = record.get("attempts")?.as_u64()?;
    let status = EpicStatus::parse(record.get("status"))?;
    Some((
        id,
        EpicState {
            epic,
            attempts,
            status,
            main_at_failure: record
                .get("mainAtFailure")
                .and_then(Value::as_str)
                .map(str::to_string),
            retry_scheduled: false,
            retry_token: 0,
        },
    ))
}

fn parse_manual_run(value: &Value) -> Option<StoredManualRun> {
    let record = value.as_object()?;
    let file = record.get("file")?.as_str()?.to_string();
    let title = record.get("title")?.as_str()?.to_string();
    if record.get("action").and_then(Value::as_str) != Some("resolving") {
        return None;
    }
    Some(StoredManualRun {
        file,
        title,
        activity: parse_activity(record.get("activity"))?,
        question: parse_question(record.get("question")),
    })
}

fn dedup_epics(epics: Vec<Epic>) -> Vec<Epic> {
    let mut seen = HashSet::new();
    let mut kept = Vec::new();
    for epic in epics {
        if seen.insert(epic.number) {
            kept.push(epic);
        }
    }
    kept
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

#[derive(Clone)]
enum Target {
    Conn(Conn),
    Shared(Arc<App>),
}

impl Target {
    fn send(&self, event: Value) {
        match self {
            Self::Conn(conn) => conn.send(event),
            Self::Shared(app) => app.shared.broadcast(event),
        }
    }
}

fn error_event(message: impl Into<String>) -> Value {
    json!({"type": "error", "message": message.into()})
}

/// A manual run's replayable frame set.
struct ManualView {
    file: String,
    title: String,
    action: String,
    activity: Vec<String>,
    question: Option<RunQuestion>,
}

impl From<&Arc<ManualRun>> for ManualView {
    fn from(run: &Arc<ManualRun>) -> Self {
        Self {
            file: run.file.clone(),
            title: run.title.clone(),
            action: run.action.clone(),
            activity: run.activity(),
            question: run.question(),
        }
    }
}

fn send_run_conversation(target: &Conn, run: &ManualView) {
    target.send(json!({
        "type": "runStarted",
        "file": run.file,
        "title": run.title,
        "action": run.action,
        "manual": true,
    }));
    for text in &run.activity {
        target.send(json!({"type": "activity", "text": text}));
    }
    if let Some(question) = &run.question {
        target.send(json!({
            "type": "question",
            "id": question.id,
            "message": question.message,
            "options": question.options,
        }));
    }
}

fn send_finished_run(target: &Conn, run: &FinishedManualRun) {
    target.send(json!({
        "type": "runStopped",
        "file": run.file,
        "title": run.title,
        "resolved": run.resolved,
        "status": run.status,
        "activity": run.activity,
    }));
}

fn lane_snapshot(inner: &Inner) -> Value {
    let running = inner
        .lanes
        .iter()
        .filter(|lane| {
            lane.kind == LaneKind::Implementation && lane.status() == LaneStatus::Running
        })
        .count();
    json!({
        "type": "laneState",
        "lanes": inner.lanes.iter().map(|lane| lane.snapshot()).collect::<Vec<_>>(),
        "openEpics": inner.known_epics.len(),
        "runningLanes": running,
    })
}

// ---------------------------------------------------------------------------
// Lifecycle commands
// ---------------------------------------------------------------------------

impl GoalRun {
    async fn start_lifecycle(self: &Arc<Self>, app: &Arc<App>, target: &Target) {
        if refuse_flow(app, target) {
            return;
        }
        if refuse_discover(app, target) {
            return;
        }
        // A stopped run leaves the loop at its next check, but its own finale
        // may still be in flight. Wait for it so the two runs cannot both
        // publish.
        self.wait_for_unwinding().await;
        if let Some(message) = authoring_refusal(
            app,
            &[
                "A skills preparation is active.",
                "A goal creation is active.",
                "A goal revision is active.",
            ],
        ) {
            target.send(error_event(message));
            return;
        }
        if self.is_running() {
            target.send(error_event("A lifecycle run is already active."));
            return;
        }
        if self.manual_active() {
            target.send(error_event("A run is already active."));
            return;
        }

        let request = {
            let mut inner = lock(&self.inner);
            inner.lifecycle_start_request += 1;
            inner.lifecycle_start_request
        };

        let goal_settled = tokio::fs::read_to_string(&app.config().goal_file)
            .await
            .map(|text| !text.trim().is_empty())
            .unwrap_or(false);
        if !self.request_current(request) {
            return;
        }
        if !goal_settled {
            target.send(error_event(
                "The goal is not set. Save a non-empty goal before starting the lifecycle.",
            ));
            return;
        }

        match prepared_skill_count(app).await {
            Ok(0) => {
                target.send(error_event(
                    "No skills are prepared. Prepare skills before starting the lifecycle.",
                ));
                return;
            }
            Ok(_) => {}
            Err(message) => {
                target.send(error_event(format!(
                    "Could not read the installed skills: {message}"
                )));
                return;
            }
        }
        if !self.request_current(request) {
            return;
        }

        self.clear_lane_state(app);
        {
            let mut inner = lock(&self.inner);
            inner.lifecycle_running = true;
            inner.unwinding = true;
            inner.lifecycle = Lifecycle {
                stage: Stage::Epic,
                pass: inner.lifecycle.pass,
                work: None,
                paused: false,
            };
        }
        app.shared.journal.write("lifecycle", "start", None);
        self.start_main_watcher(app);
        self.publish_lifecycle(app, true);

        let this = Arc::clone(self);
        let app = Arc::clone(app);
        tokio::spawn(async move {
            this.lifecycle_loop(&app, request).await;
        });
    }

    async fn lifecycle_loop(self: Arc<Self>, app: &Arc<App>, request: u64) {
        let mut finished = false;
        match self.read_epic_list(app).await {
            Ok(list) => {
                if self.running_for(request) {
                    self.apply_epic_list(app, list);
                    self.hold_while_paused().await;
                    if lock(&self.inner).lifecycle_running {
                        self.reconcile_lanes(app);
                        finished = self.run_lifecycle(app).await;
                    }
                }
            }
            Err(message) => {
                if self.running_for(request) {
                    app.shared.broadcast(error_event(message));
                }
            }
        }
        let was_paused = lock(&self.inner).lifecycle.paused;
        self.finalize_lifecycle_run(app, finished, was_paused);
    }

    async fn wait_for_unwinding(self: &Arc<Self>) {
        loop {
            let notified = self.unwound.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if !lock(&self.inner).unwinding {
                return;
            }
            notified.await;
        }
    }

    fn finalize_lifecycle_run(self: &Arc<Self>, app: &Arc<App>, finished: bool, was_paused: bool) {
        {
            let mut inner = lock(&self.inner);
            inner.lifecycle_running = false;
            inner.lifecycle_paused_for_manual_run = false;
        }
        if self.stop_all_lanes() {
            self.publish_lanes(app);
        }
        {
            let mut inner = lock(&self.inner);
            inner.lifecycle.paused = false;
        }
        self.notify_resume();
        {
            let mut inner = lock(&self.inner);
            inner.unwinding = false;
        }
        self.unwound.notify_waiters();
        if finished {
            if was_paused {
                self.publish_lifecycle(app, false);
            } else {
                persist_now(app);
            }
        } else {
            let mut inner = lock(&self.inner);
            inner.lifecycle = Lifecycle::idle(inner.lifecycle.pass);
            drop(inner);
            self.publish_lifecycle(app, false);
        }
        self.wake_lifecycle();
    }

    fn pause_lifecycle(self: &Arc<Self>, target: &Target) {
        if !self.is_running() {
            target.send(error_event("No lifecycle run is active."));
            return;
        }
        if lock(&self.inner).lifecycle.paused {
            target.send(error_event("The lifecycle run is already paused."));
            return;
        }
        {
            let live: Vec<Arc<Lane>> = lock(&self.inner).live.values().cloned().collect();
            for lane in live {
                if lane.status() != LaneStatus::Running {
                    continue;
                }
                if let Some(agent) = lock(&lane.agent).as_ref() {
                    agent.pause();
                }
                lane.set_status(LaneStatus::Paused);
            }
            lock(&self.inner).lifecycle.paused = true;
        }
        let app = app_of(self);
        self.publish_lifecycle(&app, false);
        self.publish_lanes(&app);
        self.wake_lifecycle();
    }

    async fn resume_lifecycle(self: &Arc<Self>, app: &Arc<App>, target: &Target) {
        if refuse_discover(app, target) {
            return;
        }
        if let Some(message) = authoring_refusal(
            app,
            &[
                "A skills preparation is active.",
                "A goal creation is active.",
                "A goal revision is active.",
            ],
        ) {
            target.send(error_event(message));
            return;
        }
        if !self.is_running() {
            target.send(error_event("No lifecycle run is active."));
            return;
        }
        if self.manual_run_active() {
            target.send(error_event("A manual ADR run is active."));
            return;
        }
        if lock(&self.inner).manual_sequencing {
            lock(&self.inner).resume_after_manual_sequence = true;
            return;
        }
        if !lock(&self.inner).lifecycle.paused {
            target.send(error_event("The lifecycle run is not paused."));
            return;
        }
        {
            let mut inner = lock(&self.inner);
            inner.lifecycle.paused = false;
        }
        self.publish_lifecycle(app, false);
        {
            let live: Vec<Arc<Lane>> = lock(&self.inner).live.values().cloned().collect();
            for lane in live {
                if lane.status() != LaneStatus::Paused {
                    continue;
                }
                if let Some(agent) = lock(&lane.agent).as_ref() {
                    agent.resume();
                }
                lane.set_status(LaneStatus::Running);
            }
        }
        self.publish_lanes(app);
        self.notify_resume();
        self.wake_lifecycle();

        let restored_paused = {
            let mut inner = lock(&self.inner);
            std::mem::take(&mut inner.restored_paused_lifecycle)
        };
        if restored_paused {
            let this = Arc::clone(self);
            let app = Arc::clone(app);
            tokio::spawn(async move {
                this.continue_restored_lifecycle(&app).await;
            });
        }
    }

    fn stop_lifecycle(self: &Arc<Self>, app: &Arc<App>, target: &Target) {
        if !self.is_running() {
            target.send(error_event("No lifecycle run is active."));
            return;
        }
        {
            let mut inner = lock(&self.inner);
            inner.lifecycle_paused_for_manual_run = false;
            inner.lifecycle_running = false;
        }
        self.abort_tracker_reads();
        app.shared.journal.write("lifecycle", "stop", None);
        if self.stop_all_lanes() {
            self.publish_lanes(app);
        }
        {
            let mut inner = lock(&self.inner);
            inner.lifecycle = Lifecycle::idle(inner.lifecycle.pass);
        }
        self.publish_lifecycle(app, true);
        self.notify_resume();
        self.wake_lifecycle();
    }

    /// Returns true only when the run produced no epic and no pending ADR.
    async fn run_lifecycle(self: &Arc<Self>, app: &Arc<App>) -> bool {
        let mut previous_pending: Option<String> = None;

        while self.is_running() {
            self.hold_while_paused().await;
            if !self.is_running() {
                return false;
            }
            if self.lanes_busy() {
                self.wait_for_lifecycle_change().await;
                continue;
            }
            if self.has_retrying_epic() {
                self.wait_for_lifecycle_change().await;
                continue;
            }

            self.reconcile_lanes(app);
            if self.lanes_busy() || self.has_retrying_epic() {
                continue;
            }

            let parked = { lock(&self.inner).parked_epics.clone() };
            if !parked.is_empty() {
                if !self.generation_attempted() {
                    self.run_generation_pass(app).await;
                    self.reconcile_lanes(app);
                    if self.lanes_busy() || self.has_retrying_epic() {
                        continue;
                    }
                }
                let remaining = { lock(&self.inner).parked_epics.clone() };
                if !remaining.is_empty() {
                    let mut ids: Vec<i64> = remaining
                        .iter()
                        .map(|id| id.parse::<i64>().unwrap_or(i64::MAX))
                        .collect();
                    ids.sort_unstable();
                    let names = ids
                        .iter()
                        .map(|id| format!("#{id}"))
                        .collect::<Vec<_>>()
                        .join(", ");
                    app.shared.broadcast(error_event(format!(
                        "Lifecycle stopped with parked epics: {names}."
                    )));
                    return false;
                }
            }

            let known_empty = { lock(&self.inner).known_epics.is_empty() };
            if known_empty && !self.generation_attempted() {
                self.run_generation_pass(app).await;
                self.reconcile_lanes(app);
                if self.lanes_busy() || self.has_retrying_epic() {
                    continue;
                }
                if !lock(&self.inner).known_epics.is_empty() {
                    continue;
                }
            }

            if !lock(&self.inner).known_epics.is_empty() {
                self.wait_for_lifecycle_change().await;
                continue;
            }

            let list = read_records(app);
            self.hold_while_paused().await;
            if !self.is_running() {
                return false;
            }
            let pending: Vec<String> = match &list {
                Ok((records, _)) => records.iter().filter_map(pending_file).collect(),
                Err(message) => {
                    app.shared.broadcast(error_event(message.clone()));
                    return false;
                }
            };
            if pending.is_empty() {
                self.set_lifecycle(app, Stage::Finished, None);
                return true;
            }
            let signature = pending.join("\n");
            if previous_pending.as_deref() == Some(signature.as_str()) {
                app.shared.broadcast(error_event(
                    "Epic generation left the same ADRs pending without opening an epic.",
                ));
                return false;
            }
            previous_pending = Some(signature);

            for file in pending {
                self.hold_while_paused().await;
                if !self.is_running() {
                    return false;
                }
                let record = read_record(app, &file);
                self.hold_while_paused().await;
                if !self.is_running() {
                    return false;
                }
                let Some(record) = record else {
                    continue;
                };
                if !record_pending(&record) {
                    continue;
                }
                self.run_adr_lane(app, record).await;
                self.hold_while_paused().await;
                if !self.is_running() {
                    return false;
                }
            }

            self.set_lifecycle(app, Stage::Epic, None);
            {
                let mut inner = lock(&self.inner);
                inner.generation_attempted = false;
            }
        }
        false
    }

    fn set_lifecycle(self: &Arc<Self>, app: &Arc<App>, stage: Stage, work: Option<Work>) {
        {
            let mut inner = lock(&self.inner);
            inner.lifecycle = Lifecycle {
                stage,
                pass: inner.lifecycle.pass,
                work,
                paused: inner.lifecycle.paused,
            };
        }
        let detail = match &lock(&self.inner).lifecycle.work {
            None => stage.as_str().to_string(),
            Some(work) => format!(
                "{} {}",
                stage.as_str(),
                match work.kind {
                    WorkKind::Adr => "adr",
                    WorkKind::Epic => "epic",
                }
            ),
        };
        app.shared.journal.write("lifecycle", &detail, None);
        self.publish_lifecycle(app, false);
    }

    fn publish_lifecycle(self: &Arc<Self>, app: &Arc<App>, force: bool) {
        let event = {
            let mut inner = lock(&self.inner);
            if !force
                && inner
                    .last_lifecycle
                    .as_ref()
                    .is_some_and(|last| last.same_shape(&inner.lifecycle))
            {
                return;
            }
            inner.last_lifecycle = Some(inner.lifecycle.clone());
            inner.lifecycle.to_json()
        };
        let mut frame = event;
        frame["type"] = json!("lifecycleState");
        app.shared.broadcast(frame);
    }

    fn publish_lanes(self: &Arc<Self>, app: &Arc<App>) {
        let (snapshot, lanes) = {
            let inner = lock(&self.inner);
            (lane_snapshot(&inner), inner.lanes.clone())
        };
        app.shared.broadcast(snapshot);
        for lane in lanes {
            self.schedule_lane_removal(app, &lane);
        }
    }

    /// Drops a finished lane once its retention window elapses.
    fn schedule_lane_removal(self: &Arc<Self>, app: &Arc<App>, lane: &Arc<Lane>) {
        let status = lane.status();
        if !status.retained() {
            return;
        }
        let now = now_millis();
        let until = {
            let mut retainer = lock(&lane.retainer);
            match *retainer {
                Some(until) => until,
                None => {
                    let until = now + LANE_RETENTION_MS;
                    *retainer = Some(until);
                    until
                }
            }
        };
        if lane.retention_scheduled.swap(true, Ordering::SeqCst) {
            return;
        }
        let delay = until.saturating_sub(now);
        let lane_epoch = lock(&self.inner).lane_epoch;
        let this = Arc::clone(self);
        let app = Arc::clone(app);
        let id = lane.id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            let mut removed = false;
            {
                let mut inner = lock(&this.inner);
                if inner.lane_epoch != lane_epoch {
                    return;
                }
                if let Some(index) = inner.lanes.iter().position(|entry| entry.id == id) {
                    inner.lanes.remove(index);
                    removed = true;
                }
            }
            if removed {
                this.publish_lanes(&app);
            }
        });
    }

    fn publish_stage(self: &Arc<Self>, app: &Arc<App>) {
        if !self.is_running() {
            return;
        }
        let (implementations, adr, generating, epic_waiting) = {
            let inner = lock(&self.inner);
            let implementations: Vec<Arc<Lane>> = inner
                .live
                .values()
                .filter(|lane| lane.kind == LaneKind::Implementation)
                .cloned()
                .collect();
            let adr = inner
                .live
                .values()
                .find(|lane| lane.kind == LaneKind::Adr)
                .cloned();
            let generating = inner
                .live
                .values()
                .any(|lane| lane.kind == LaneKind::Generation);
            let epic_waiting = inner.epic_states.values().any(|state| {
                matches!(
                    state.status,
                    EpicStatus::Running | EpicStatus::Retrying | EpicStatus::Parked
                )
            });
            (implementations, adr, generating, epic_waiting)
        };
        if !implementations.is_empty() {
            let epic = if implementations.len() == 1 {
                lock(&implementations[0].epic).clone()
            } else {
                None
            };
            self.set_lifecycle(
                app,
                Stage::Implementation,
                epic.map(|epic| Work {
                    kind: WorkKind::Epic,
                    id: epic.id(),
                    url: (!epic.url.is_empty()).then_some(epic.url),
                }),
            );
            return;
        }
        if let Some(lane) = adr {
            self.set_lifecycle(
                app,
                Stage::Adr,
                Some(Work {
                    kind: WorkKind::Adr,
                    id: lane
                        .record
                        .as_ref()
                        .map(|record| record.file.clone())
                        .unwrap_or_default(),
                    url: None,
                }),
            );
            return;
        }
        if epic_waiting {
            self.set_lifecycle(app, Stage::Implementation, None);
            return;
        }
        if generating {
            self.set_lifecycle(app, Stage::Epic, None);
        }
    }

    fn apply_epic_list(self: &Arc<Self>, app: &Arc<App>, list: Vec<Epic>) {
        {
            let mut inner = lock(&self.inner);
            inner.known_epics = dedup_epics(list);
        }
        self.publish_lanes(app);
    }
}

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

impl GoalRun {
    fn is_running(&self) -> bool {
        lock(&self.inner).lifecycle_running
    }

    fn manual_run_active(&self) -> bool {
        lock(&self.inner).manual_run.is_some()
    }

    fn manual_active(&self) -> bool {
        let inner = lock(&self.inner);
        inner.manual_run.is_some() || inner.manual_sequencing
    }

    fn request_current(&self, request: u64) -> bool {
        lock(&self.inner).lifecycle_start_request == request
    }

    fn running_for(&self, request: u64) -> bool {
        let inner = lock(&self.inner);
        inner.lifecycle_running && inner.lifecycle_start_request == request
    }

    fn lanes_busy(&self) -> bool {
        let inner = lock(&self.inner);
        !inner.live.is_empty() || inner.generation_active || inner.generation_queued
    }

    fn has_retrying_epic(&self) -> bool {
        lock(&self.inner)
            .epic_states
            .values()
            .any(|state| state.status == EpicStatus::Retrying)
    }

    fn generation_attempted(&self) -> bool {
        lock(&self.inner).generation_attempted
    }

    fn lane_live(&self, lane: &Arc<Lane>) -> bool {
        lock(&self.inner)
            .live
            .get(&lane.id)
            .is_some_and(|current| Arc::ptr_eq(current, lane))
    }

    fn add_lane(self: &Arc<Self>, app: &Arc<App>, lane: Arc<Lane>) {
        {
            let mut inner = lock(&self.inner);
            inner.lanes.push(Arc::clone(&lane));
            inner.live.insert(lane.id.clone(), Arc::clone(&lane));
        }
        self.publish_lanes(app);
    }

    fn next_lane_id(&self) -> String {
        let mut inner = lock(&self.inner);
        inner.lane_sequence += 1;
        format!("lane-{}", inner.lane_sequence)
    }

    fn live_implementation_for(&self, id: &str) -> bool {
        lock(&self.inner).live.values().any(|lane| {
            lane.kind == LaneKind::Implementation
                && lock(&lane.epic)
                    .as_ref()
                    .is_some_and(|epic| epic.id() == id)
        })
    }

    fn clear_retry(&self, id: &str) {
        let mut inner = lock(&self.inner);
        if let Some(state) = inner.epic_states.get_mut(id) {
            state.retry_scheduled = false;
            state.retry_token = state.retry_token.wrapping_add(1);
        }
    }

    fn schedule_retry(self: &Arc<Self>, id: &str) {
        let mut inner = lock(&self.inner);
        self.schedule_retry_locked(&mut inner, id);
    }

    fn schedule_retry_locked(self: &Arc<Self>, inner: &mut Inner, id: &str) {
        let Some(state) = inner.epic_states.get_mut(id) else {
            return;
        };
        if state.retry_scheduled {
            return;
        }
        state.retry_scheduled = true;
        state.retry_token = state.retry_token.wrapping_add(1);
        let token = state.retry_token;
        let this = Arc::clone(self);
        let id = id.to_string();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(LANE_BACKOFF_MS)).await;
            let Some(app) = this.app.get().and_then(Weak::upgrade) else {
                return;
            };
            {
                let mut inner = lock(&this.inner);
                let Some(state) = inner.epic_states.get_mut(&id) else {
                    return;
                };
                if state.retry_token != token {
                    return;
                }
                state.retry_scheduled = false;
            }
            this.retry_epic(&app, &id).await;
        });
    }

    async fn retry_epic(self: &Arc<Self>, app: &Arc<App>, id: &str) {
        self.hold_while_paused().await;
        if !self.is_running() {
            return;
        }
        let (status, attempts) = {
            let inner = lock(&self.inner);
            match inner.epic_states.get(id) {
                Some(state) if state.status == EpicStatus::Retrying => {
                    (state.status, state.attempts)
                }
                _ => return,
            }
        };
        if status != EpicStatus::Retrying || self.live_implementation_for(id) {
            return;
        }
        self.start_implementation_lane(app, id, attempts + 1);
    }

    fn start_implementation_lane(self: &Arc<Self>, app: &Arc<App>, id: &str, attempt: u64) {
        // Claim the epic and its lane under one lock: two tasks reconciling at
        // once must never open two lanes for the same epic.
        let lane = {
            let mut inner = lock(&self.inner);
            if inner.lifecycle.paused {
                return;
            }
            let Some(epic) = inner
                .known_epics
                .iter()
                .find(|epic| epic.id() == id)
                .cloned()
            else {
                return;
            };
            let live = inner.live.values().any(|lane| {
                lane.kind == LaneKind::Implementation
                    && lock(&lane.epic)
                        .as_ref()
                        .is_some_and(|epic| epic.id() == id)
            });
            if live {
                return;
            }
            match inner.epic_states.get_mut(id) {
                Some(state) => {
                    state.retry_scheduled = false;
                    state.retry_token = state.retry_token.wrapping_add(1);
                    state.epic = epic.clone();
                    state.attempts = attempt;
                    state.status = EpicStatus::Running;
                    state.main_at_failure = None;
                }
                None => {
                    inner.epic_states.insert(
                        id.to_string(),
                        EpicState {
                            epic: epic.clone(),
                            attempts: attempt,
                            status: EpicStatus::Running,
                            main_at_failure: None,
                            retry_scheduled: false,
                            retry_token: 0,
                        },
                    );
                }
            }
            inner.parked_epics.remove(id);
            inner.generation_attempted = false;
            inner.lane_sequence += 1;
            let lane = Arc::new(Lane::new(
                format!("lane-{}", inner.lane_sequence),
                LaneKind::Implementation,
                Some(epic),
                None,
                attempt,
                LaneStatus::Running,
            ));
            inner.lanes.push(Arc::clone(&lane));
            inner.live.insert(lane.id.clone(), Arc::clone(&lane));
            lane
        };
        self.publish_lanes(app);
        self.publish_stage(app);

        let this = Arc::clone(self);
        let app = Arc::clone(app);
        let id = id.to_string();
        tokio::spawn(async move {
            this.continue_implementation_lane(&app, lane, &id).await;
        });
    }

    async fn continue_implementation_lane(
        self: &Arc<Self>,
        app: &Arc<App>,
        lane: Arc<Lane>,
        id: &str,
    ) {
        self.run_lane_peer(app, &lane, &format!("{IMPLEMENT_PROMPT} {id}"))
            .await;
        if !self.is_running() {
            return;
        }

        let mut list = match self
            .settle_epic_list(app, |candidate| {
                candidate.iter().any(|entry| entry.id() == id)
            })
            .await
        {
            Ok(list) => {
                self.hold_while_paused().await;
                if !self.is_running() {
                    return;
                }
                self.apply_epic_list(app, list.clone());
                list
            }
            Err(message) => {
                if !self.is_running() {
                    return;
                }
                app.shared.broadcast(json!({
                    "type": "error",
                    "lane": lane.id,
                    "message": message,
                }));
                let inner = lock(&self.inner);
                inner.known_epics.clone()
            }
        };
        list.clear();

        if !self.is_running() {
            return;
        }
        let still_open = lock(&self.inner)
            .known_epics
            .iter()
            .any(|epic| epic.id() == id);

        if !still_open {
            lane.set_status(LaneStatus::Closed);
            {
                let mut inner = lock(&self.inner);
                if let Some(state) = inner.epic_states.get_mut(id) {
                    state.retry_scheduled = false;
                    state.retry_token = state.retry_token.wrapping_add(1);
                }
                inner.epic_states.remove(id);
                inner.parked_epics.remove(id);
            }
            self.broadcast_lane_stopped(app, &lane, true, "closed");
            let others = lock(&self.inner)
                .live
                .values()
                .any(|entry| entry.kind == LaneKind::Implementation);
            if others {
                self.publish_stage(app);
            } else {
                let mut inner = lock(&self.inner);
                inner.lifecycle = Lifecycle {
                    stage: Stage::Epic,
                    pass: inner.lifecycle.pass + 1,
                    work: None,
                    paused: inner.lifecycle.paused,
                };
                drop(inner);
                self.publish_lifecycle(app, false);
            }
            self.publish_lanes(app);
            self.request_generation(app);
            return;
        }

        if let Some(epic) = lock(&self.inner)
            .known_epics
            .iter()
            .find(|epic| epic.id() == id)
            .cloned()
        {
            let mut inner = lock(&self.inner);
            if let Some(state) = inner.epic_states.get_mut(id) {
                state.epic = epic;
            }
        }
        let stopped_main = self.read_main_revision(app).await;
        {
            let mut inner = lock(&self.inner);
            if let Some(state) = inner.epic_states.get_mut(id) {
                if let Some(main) = stopped_main {
                    state.main_at_failure = Some(main);
                }
            }
        }
        if lane.blocked.load(Ordering::SeqCst) {
            lane.set_status(LaneStatus::Parked);
            {
                let mut inner = lock(&self.inner);
                if let Some(state) = inner.epic_states.get_mut(id) {
                    state.status = EpicStatus::Parked;
                }
                inner.parked_epics.insert(id.to_string());
            }
            self.broadcast_lane_stopped(app, &lane, false, "parked");
        } else {
            lane.set_status(LaneStatus::Retrying);
            {
                let mut inner = lock(&self.inner);
                if let Some(state) = inner.epic_states.get_mut(id) {
                    state.status = EpicStatus::Retrying;
                }
            }
            app.shared.broadcast(json!({
                "type": "error",
                "lane": lane.id,
                "message": format!("Implementation ended but epic #{id} is still open."),
            }));
            self.broadcast_lane_stopped(app, &lane, false, "retrying");
            self.schedule_retry(id);
        }
        self.publish_lanes(app);
        self.publish_stage(app);
        self.wake_lifecycle();
    }

    /// Starts a lane for every open epic that does not already own one.
    fn reconcile_lanes(self: &Arc<Self>, app: &Arc<App>) {
        let (known, states) = {
            let inner = lock(&self.inner);
            (
                inner.known_epics.clone(),
                inner
                    .epic_states
                    .iter()
                    .map(|(id, state)| (id.clone(), state.status, state.attempts))
                    .collect::<Vec<_>>(),
            )
        };
        for epic in &known {
            let id = epic.id();
            match states.iter().find(|(state_id, _, _)| state_id == &id) {
                Some((_, EpicStatus::Closed, attempts)) => {
                    self.start_implementation_lane(app, &id, attempts + 1);
                }
                None => self.start_implementation_lane(app, &id, 1),
                _ => {}
            }
        }
        let stale: Vec<String> = {
            let inner = lock(&self.inner);
            inner
                .epic_states
                .keys()
                .filter(|id| {
                    !known.iter().any(|epic| &epic.id() == *id) && !self.live_implementation_for(id)
                })
                .cloned()
                .collect()
        };
        for id in stale {
            self.clear_retry(&id);
            let mut inner = lock(&self.inner);
            inner.epic_states.remove(&id);
            inner.parked_epics.remove(&id);
        }
        self.publish_stage(app);
    }

    async fn run_generation_pass(self: &Arc<Self>, app: &Arc<App>) {
        // One generation peer at a time: a pass the loop starts and a pass a
        // drain starts are serialized, and neither request is dropped.
        let _permit = self.generation_gate.lock().await;
        {
            let mut inner = lock(&self.inner);
            if !inner.lifecycle_running {
                return;
            }
            inner.generation_attempted = true;
        }
        let before: HashSet<String> = lock(&self.inner).known_epics.iter().map(Epic::id).collect();
        let lane = Arc::new(Lane::new(
            self.next_lane_id(),
            LaneKind::Generation,
            None,
            None,
            1,
            LaneStatus::Running,
        ));
        self.add_lane(app, Arc::clone(&lane));
        self.publish_stage(app);
        self.continue_generation_lane(app, &lane, before).await;
        self.wake_lifecycle();
    }

    async fn continue_generation_lane(
        self: &Arc<Self>,
        app: &Arc<App>,
        lane: &Arc<Lane>,
        before: HashSet<String>,
    ) {
        self.run_lane_peer(app, lane, EPIC_PROMPT).await;
        let failed = lane.failure().is_some();
        lane.set_status(if failed {
            LaneStatus::Failed
        } else {
            LaneStatus::Closed
        });
        let status = lane.status().as_str();
        self.broadcast_lane_stopped(app, lane, !failed, status);
        self.publish_lanes(app);
        if !self.is_running() {
            return;
        }
        match self
            .settle_epic_list(app, |candidate| {
                !candidate.iter().any(|entry| !before.contains(&entry.id()))
            })
            .await
        {
            Ok(list) => {
                if !self.is_running() {
                    return;
                }
                self.apply_epic_list(app, list);
            }
            Err(message) => {
                if !self.is_running() {
                    return;
                }
                app.shared.broadcast(json!({
                    "type": "error",
                    "lane": lane.id,
                    "message": message,
                }));
            }
        }
    }

    fn request_generation(self: &Arc<Self>, app: &Arc<App>) {
        {
            let mut inner = lock(&self.inner);
            inner.generation_queued = true;
            inner.generation_attempted = false;
        }
        self.wake_lifecycle();
        let this = Arc::clone(self);
        let app = Arc::clone(app);
        tokio::spawn(async move {
            this.drain_generations(&app).await;
        });
    }

    async fn drain_generations(self: &Arc<Self>, app: &Arc<App>) {
        {
            let mut inner = lock(&self.inner);
            if inner.generation_active || !inner.lifecycle_running {
                return;
            }
            inner.generation_active = true;
        }
        loop {
            let queued = {
                let inner = lock(&self.inner);
                inner.generation_queued && inner.lifecycle_running
            };
            if !queued {
                break;
            }
            {
                let mut inner = lock(&self.inner);
                inner.generation_queued = false;
            }
            self.hold_while_paused().await;
            if !self.is_running() {
                break;
            }
            self.run_generation_pass(app).await;
            self.reconcile_lanes(app);
            self.wake_lifecycle();
        }
        {
            let mut inner = lock(&self.inner);
            inner.generation_active = false;
        }
        self.wake_lifecycle();
    }

    async fn run_adr_lane(self: &Arc<Self>, app: &Arc<App>, record: Value) {
        if !self.is_running() {
            return;
        }
        let Some(file) = record_file(&record) else {
            return;
        };
        let title = record_title(&record);
        let lane = Arc::new(Lane::new(
            self.next_lane_id(),
            LaneKind::Adr,
            None,
            Some(RecordRef {
                file: file.clone(),
                title,
            }),
            1,
            LaneStatus::Running,
        ));
        self.add_lane(app, Arc::clone(&lane));
        self.set_lifecycle(
            app,
            Stage::Adr,
            Some(Work {
                kind: WorkKind::Adr,
                id: file,
                url: None,
            }),
        );
        self.publish_lanes(app);
        self.continue_adr_lane(app, &lane).await;
    }

    async fn continue_adr_lane(self: &Arc<Self>, app: &Arc<App>, lane: &Arc<Lane>) {
        let file = lane
            .record
            .as_ref()
            .map(|record| record.file.clone())
            .unwrap_or_default();
        let prompt = crate::acp::agent_prompt(&app.config().adrs_dir.to_string_lossy(), &file);
        self.run_lane_peer(app, lane, &prompt).await;
        let failed = lane.failure().is_some();
        lane.set_status(if failed {
            LaneStatus::Failed
        } else {
            LaneStatus::Closed
        });
        let current = read_record(app, &file);
        let resolved = current
            .as_ref()
            .is_some_and(|record| !record_pending(record));
        let status = current.as_ref().map(record_status).unwrap_or_default();
        self.broadcast_lane_stopped(app, lane, resolved, &status);
        self.publish_lanes(app);
        match read_records(app) {
            Ok((records, next)) => app
                .shared
                .broadcast(json!({"type": "records", "records": records, "next": next})),
            Err(message) => app.shared.broadcast(error_event(message)),
        }
    }

    /// Runs one lane's peer and records its question and activity.
    async fn run_lane_peer(self: &Arc<Self>, app: &Arc<App>, lane: &Arc<Lane>, prompt: &str) {
        app.shared.journal.write(
            "lane-start",
            &format!("{} {} {}", lane.id, lane.kind.as_str(), lane.title()),
            None,
        );
        app.shared.broadcast(json!({
            "type": "runStarted",
            "lane": lane.id,
            "kind": lane.kind.as_str(),
            "attempt": lane.attempt,
            "file": lane.record.as_ref().map(|record| record.file.clone()).unwrap_or_default(),
            "title": lane.title(),
            "action": lane.action(),
        }));
        let outcome = self.drive_lane_peer(app, lane, prompt).await;
        if let Err(message) = outcome {
            if self.lane_live(lane) {
                *lock(&lane.failure) = Some(message.clone());
                app.shared.journal.write("server-error", &message, None);
                app.shared.broadcast(json!({
                    "type": "error",
                    "lane": lane.id,
                    "message": message,
                }));
            }
        }
        lane.close_peer();
        *lock(&lane.question) = None;
        let mut inner = lock(&self.inner);
        inner.live.remove(&lane.id);
    }

    async fn drive_lane_peer(
        self: &Arc<Self>,
        app: &Arc<App>,
        lane: &Arc<Lane>,
        prompt: &str,
    ) -> Result<(), String> {
        let environment = app
            .providers
            .select_environment()
            .await
            .map_err(|error| error.message)?;
        if !self.lane_live(lane) {
            return Ok(());
        }
        let (connection, events) = connect_peer(app, environment).await?;
        if !self.lane_live(lane) {
            connection.close();
            return Ok(());
        }
        let connection = Arc::new(connection);
        *lock(&lane.agent) = Some(Arc::clone(&connection));
        if lock(&self.inner).lifecycle.paused {
            connection.pause();
        }
        self.drive_lane_events(app, lane, events, &connection, prompt)
            .await
    }

    async fn drive_lane_events(
        self: &Arc<Self>,
        app: &Arc<App>,
        lane: &Arc<Lane>,
        mut events: mpsc::UnboundedReceiver<AcpEvent>,
        connection: &Arc<AcpConnection>,
        prompt: &str,
    ) -> Result<(), String> {
        let run = connection.run(prompt);
        tokio::pin!(run);
        let outcome = loop {
            tokio::select! {
                event = events.recv() => {
                    match event {
                        Some(event) => self.apply_lane_event(app, lane, event),
                        None => break run.await,
                    }
                }
                result = &mut run => break result,
            }
        };
        while let Ok(event) = events.try_recv() {
            self.apply_lane_event(app, lane, event);
        }
        outcome.map(|_| ()).map_err(|error| error.message)
    }

    fn apply_lane_event(self: &Arc<Self>, app: &Arc<App>, lane: &Arc<Lane>, event: AcpEvent) {
        match event {
            AcpEvent::Activity(activity) => {
                if !self.lane_live(lane) {
                    return;
                }
                record_output(app, &lane.activity, &activity, Some(&lane.id));
                if lock(&lane.activity)
                    .iter()
                    .any(|line| line.starts_with(BLOCKER_MARKER))
                {
                    lane.blocked.store(true, Ordering::SeqCst);
                }
            }
            AcpEvent::Question(question) => {
                app.shared.journal.write(
                    "question",
                    &question.message,
                    Some(&format!("lane:{}", lane.id)),
                );
                if !self.lane_live(lane) {
                    return;
                }
                let stored = store_question(&question);
                *lock(&lane.question) = Some(stored.clone());
                app.shared.broadcast(json!({
                    "type": "question",
                    "lane": lane.id,
                    "id": stored.id,
                    "message": stored.message,
                    "options": stored.options,
                }));
                self.publish_lanes(app);
            }
            AcpEvent::Stderr(text) => {
                app.shared.journal.write("acp-stderr", &text, None);
                eprint!("{text}");
            }
            AcpEvent::SessionUpdate | AcpEvent::Text(_) => {}
        }
    }

    fn broadcast_lane_stopped(
        self: &Arc<Self>,
        app: &Arc<App>,
        lane: &Arc<Lane>,
        resolved: bool,
        status: &str,
    ) {
        app.shared.journal.write(
            "lane-stop",
            &format!(
                "{} {}",
                lane.id,
                if status.is_empty() { "stopped" } else { status }
            ),
            None,
        );
        app.shared.broadcast(json!({
            "type": "runStopped",
            "lane": lane.id,
            "file": lane.record.as_ref().map(|record| record.file.clone()).unwrap_or_default(),
            "title": lane.title(),
            "resolved": resolved,
            "status": status,
        }));
    }

    fn stop_all_lanes(self: &Arc<Self>) -> bool {
        self.stop_main_watcher();
        let mut inner = lock(&self.inner);
        inner.generation_queued = false;
        for state in inner.epic_states.values_mut() {
            state.retry_scheduled = false;
            state.retry_token = state.retry_token.wrapping_add(1);
        }
        let live = !inner.live.is_empty();
        let lanes: Vec<Arc<Lane>> = inner.live.values().cloned().collect();
        drop(inner);
        for lane in lanes {
            lane.close_peer();
            *lock(&lane.question) = None;
            if matches!(lane.status(), LaneStatus::Running | LaneStatus::Paused) {
                lane.set_status(LaneStatus::Failed);
            }
        }
        lock(&self.inner).live.clear();
        self.wake_lifecycle();
        live
    }

    fn clear_lane_state_silent(self: &Arc<Self>) {
        self.stop_all_lanes();
        {
            let mut inner = lock(&self.inner);
            inner.lane_epoch = inner.lane_epoch.wrapping_add(1);
            inner.lanes.clear();
            inner.epic_states.clear();
            inner.parked_epics.clear();
            inner.known_epics.clear();
            inner.generation_active = false;
            inner.generation_queued = false;
            inner.generation_attempted = false;
            inner.lane_sequence = 0;
        }
    }

    fn clear_lane_state(self: &Arc<Self>, app: &Arc<App>) {
        self.clear_lane_state_silent();
        self.publish_lanes(app);
    }

    fn read_main_revision(
        self: &Arc<Self>,
        app: &Arc<App>,
    ) -> impl Future<Output = Option<String>> {
        let repo = app.config().repo_dir.clone();
        async move {
            let result = crate::git::run_git(
                &repo,
                &["rev-parse", "--verify", "main"],
                &HashMap::new(),
                GIT_TIMEOUT_MS,
            )
            .await;
            (result.code == 0).then(|| result.stdout.trim().to_string())
        }
    }

    fn start_main_watcher(self: &Arc<Self>, app: &Arc<App>) {
        self.stop_main_watcher();
        let this = Arc::clone(self);
        let app = Arc::clone(app);
        let handle = tokio::spawn(async move {
            let mut timer = tokio::time::interval(Duration::from_millis(MAIN_POLL_MS));
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                timer.tick().await;
                if !this.is_running() {
                    return;
                }
                this.check_main_advance(&app).await;
            }
        });
        lock(&self.inner).main_watcher = Some(handle);
    }

    fn stop_main_watcher(self: &Arc<Self>) {
        let handle = lock(&self.inner).main_watcher.take();
        if let Some(handle) = handle {
            handle.abort();
        }
    }

    async fn check_main_advance(self: &Arc<Self>, app: &Arc<App>) {
        {
            let mut inner = lock(&self.inner);
            if !inner.lifecycle_running || inner.main_polling {
                return;
            }
            let has_waiting = inner
                .epic_states
                .values()
                .any(|state| matches!(state.status, EpicStatus::Retrying | EpicStatus::Parked));
            if !has_waiting {
                return;
            }
            inner.main_polling = true;
        }
        let value = self.read_main_revision(app).await;
        if let Some(value) = value {
            self.hold_while_paused().await;
            if self.is_running() {
                let waiting: Vec<(String, EpicStatus, u64)> = {
                    let inner = lock(&self.inner);
                    inner
                        .epic_states
                        .iter()
                        .filter(|(_, state)| {
                            matches!(state.status, EpicStatus::Retrying | EpicStatus::Parked)
                        })
                        .map(|(id, state)| (id.clone(), state.status, state.attempts))
                        .collect()
                };
                for (id, status, attempts) in waiting {
                    let (known, live) = {
                        let inner = lock(&self.inner);
                        (
                            inner.known_epics.iter().any(|epic| epic.id() == id),
                            inner.live.values().any(|lane| {
                                lane.kind == LaneKind::Implementation
                                    && lock(&lane.epic)
                                        .as_ref()
                                        .is_some_and(|epic| epic.id() == id)
                            }),
                        )
                    };
                    if !known || live {
                        continue;
                    }
                    let previous = {
                        let mut inner = lock(&self.inner);
                        inner
                            .epic_states
                            .get_mut(&id)
                            .and_then(|state| state.main_at_failure.clone())
                    };
                    let Some(previous) = previous else {
                        let mut inner = lock(&self.inner);
                        if let Some(state) = inner.epic_states.get_mut(&id) {
                            state.main_at_failure = Some(value.clone());
                        }
                        continue;
                    };
                    if previous == value {
                        continue;
                    }
                    self.clear_retry(&id);
                    lock(&self.inner).parked_epics.remove(&id);
                    if status == EpicStatus::Parked || status == EpicStatus::Retrying {
                        self.start_implementation_lane(app, &id, attempts + 1);
                    }
                }
                self.wake_lifecycle();
            }
        }
        lock(&self.inner).main_polling = false;
    }

    async fn read_epic_list(self: &Arc<Self>, app: &Arc<App>) -> Result<Vec<Epic>, String> {
        let repo = app.config().repo_dir.clone();
        let deadline = tokio::time::Instant::now() + Duration::from_millis(TRACKER_READ_TIMEOUT_MS);
        let abort = self.tracker_abort.notified();
        tokio::pin!(abort);
        tokio::select! {
            result = find_open_epics(&repo, TRACKER_READ_TIMEOUT_MS) => result,
            _ = &mut abort => Err("The tracker read was stopped.".to_string()),
            _ = tokio::time::sleep_until(deadline) => Err(format!(
                "The tracker did not answer within {TRACKER_READ_TIMEOUT_MS} ms; retry the read."
            )),
        }
    }

    fn abort_tracker_reads(self: &Arc<Self>) {
        self.tracker_abort.notify_waiters();
    }

    async fn settle_epic_list(
        self: &Arc<Self>,
        app: &Arc<App>,
        stale: impl Fn(&[Epic]) -> bool,
    ) -> Result<Vec<Epic>, String> {
        let mut list = self.read_epic_list(app).await?;
        for attempt in 1..TRACKER_SETTLE_ATTEMPTS {
            let _ = attempt;
            if !stale(&list) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(TRACKER_SETTLE_DELAY_MS)).await;
            self.hold_while_paused().await;
            if !self.is_running() {
                return Ok(list);
            }
            list = self.read_epic_list(app).await?;
        }
        Ok(list)
    }

    async fn continue_restored_lifecycle(self: &Arc<Self>, app: &Arc<App>) {
        lock(&self.inner).unwinding = true;
        self.start_main_watcher(app);
        let mut finished = false;
        self.spawn_restored_lanes(app);
        match self.read_epic_list(app).await {
            Ok(list) => {
                if !self.is_running() {
                    self.finalize_lifecycle_run(app, false, false);
                    return;
                }
                self.apply_epic_list(app, list);
                self.reconcile_lanes(app);
                if lock(&self.inner).generation_queued {
                    let this = Arc::clone(self);
                    let app = Arc::clone(app);
                    tokio::spawn(async move {
                        this.drain_generations(&app).await;
                    });
                }
                finished = self.run_lifecycle(app).await;
            }
            Err(message) => {
                if self.is_running() {
                    app.shared.broadcast(error_event(message));
                }
            }
        }
        self.finalize_lifecycle_run(app, finished, false);
    }

    /// Re-spawns every restored lane that has no peer yet.
    fn spawn_restored_lanes(self: &Arc<Self>, app: &Arc<App>) {
        let lanes: Vec<Arc<Lane>> = {
            let inner = lock(&self.inner);
            inner
                .live
                .values()
                .filter(|lane| lane.status() == LaneStatus::Running && lock(&lane.agent).is_none())
                .cloned()
                .collect()
        };
        for lane in lanes {
            match lane.kind {
                LaneKind::Generation => {
                    lock(&self.inner).generation_active = true;
                    let this = Arc::clone(self);
                    let app = Arc::clone(app);
                    let before: HashSet<String> =
                        lock(&self.inner).known_epics.iter().map(Epic::id).collect();
                    let lane = Arc::clone(&lane);
                    tokio::spawn(async move {
                        this.continue_generation_lane(&app, &lane, before).await;
                        lock(&this.inner).generation_active = false;
                        this.reconcile_lanes(&app);
                        this.wake_lifecycle();
                        if lock(&this.inner).generation_queued {
                            this.drain_generations(&app).await;
                        }
                    });
                }
                LaneKind::Adr => {
                    let this = Arc::clone(self);
                    let app = Arc::clone(app);
                    let lane = Arc::clone(&lane);
                    tokio::spawn(async move {
                        this.continue_adr_lane(&app, &lane).await;
                    });
                }
                LaneKind::Implementation => {
                    let Some(id) = lock(&lane.epic).as_ref().map(Epic::id) else {
                        continue;
                    };
                    let this = Arc::clone(self);
                    let app = Arc::clone(app);
                    let lane = Arc::clone(&lane);
                    tokio::spawn(async move {
                        this.continue_implementation_lane(&app, lane, &id).await;
                    });
                }
            }
        }
    }

    fn wake_lifecycle(self: &Arc<Self>) {
        self.wake.notify_waiters();
    }

    fn notify_resume(self: &Arc<Self>) {
        self.resume.notify_waiters();
    }

    async fn hold_while_paused(self: &Arc<Self>) {
        loop {
            let notified = self.resume.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let paused = {
                let inner = lock(&self.inner);
                inner.lifecycle_running && inner.lifecycle.paused
            };
            if !paused {
                return;
            }
            notified.await;
        }
    }

    async fn wait_for_lifecycle_change(self: &Arc<Self>) {
        if !self.is_running() {
            return;
        }
        tokio::select! {
            _ = self.wake.notified() => {}
            _ = tokio::time::sleep(Duration::from_millis(250)) => {}
        }
    }
}

// ---------------------------------------------------------------------------
// Manual runs
// ---------------------------------------------------------------------------

impl GoalRun {
    async fn start_run(self: &Arc<Self>, app: &Arc<App>, target: &Target, file: Option<&Value>) {
        if refuse_flow(app, target) {
            return;
        }
        if refuse_discover(app, target) {
            return;
        }
        if let Some(message) = authoring_refusal(
            app,
            &[
                "A skills preparation is active.",
                "A goal creation is active.",
                "A goal revision is active.",
            ],
        ) {
            target.send(error_event(message));
            return;
        }
        if self.manual_active() {
            target.send(error_event("A run is already active."));
            return;
        }

        let request = {
            let mut inner = lock(&self.inner);
            inner.manual_start_request += 1;
            inner.manual_start_request
        };
        let selected = file.and_then(Value::as_str).and_then(|path| {
            Path::new(path)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
        });

        let running = self.is_running();
        let paused = lock(&self.inner).lifecycle.paused;
        if running && !paused {
            let list = match read_records(app) {
                Ok((records, next)) => (records, next),
                Err(message) => {
                    target.send(error_event(message));
                    return;
                }
            };
            let (records, next) = list;
            if !self.request_manual_current(request) {
                return;
            }
            let record = match &selected {
                None => records
                    .iter()
                    .find(|record| record_file(record).as_deref() == next.as_str()),
                Some(file) => records.iter().find(|record| {
                    record_file(record).as_deref() == Some(file.as_str()) && record_pending(record)
                }),
            };
            let Some(record) = record else {
                target.send(error_event(match &selected {
                    None => "No pending ADRs to start.".to_string(),
                    Some(_) => "That ADR is not pending.".to_string(),
                }));
                return;
            };
            let conflict = {
                let inner = lock(&self.inner);
                inner.lifecycle.stage == Stage::Adr
                    && inner.lifecycle.work.as_ref().is_some_and(|work| {
                        work.kind == WorkKind::Adr
                            && Some(work.id.as_str()) == record_file(record).as_deref()
                    })
            };
            if conflict {
                target.send(error_event("The lifecycle is already resolving that ADR."));
                return;
            }
            self.pause_lifecycle(target);
            lock(&self.inner).lifecycle_paused_for_manual_run = true;
        }

        let this = Arc::clone(self);
        let app = Arc::clone(app);
        let target = target.clone();
        tokio::spawn(async move {
            this.run_manual_sequence(&app, &target, selected, None, false)
                .await;
        });
    }

    fn request_manual_current(&self, request: u64) -> bool {
        lock(&self.inner).manual_start_request == request
    }

    async fn run_manual_sequence(
        self: &Arc<Self>,
        app: &Arc<App>,
        target: &Target,
        initial: Option<String>,
        resume: Option<Arc<ManualRun>>,
        quiet_empty: bool,
    ) {
        let mut selected = initial;
        let mut first = resume.is_none();
        lock(&self.inner).manual_sequencing = true;

        let interrupted;
        let result: Result<(), String> = async {
            if let Some(run) = &resume {
                lock(&self.inner).manual_run = Some(Arc::clone(run));
                app.shared.journal.write(
                    "run-start",
                    &format!("{}: {}", run.file, run.title),
                    None,
                );
                app.shared.broadcast(json!({
                    "type": "runStarted",
                    "file": run.file,
                    "title": run.title,
                    "action": run.action,
                    "manual": true,
                }));
                if !self.run_agent(app, Arc::clone(run)).await {
                    return Ok(());
                }
            }

            loop {
                let sequencing = {
                    let inner = lock(&self.inner);
                    inner.manual_sequencing
                };
                if !sequencing {
                    break;
                }
                let (records, next) = match read_records(app) {
                    Ok(list) => list,
                    Err(message) => {
                        target.send(error_event(message));
                        return Ok(());
                    }
                };
                let record = if let Some(file) = selected.take() {
                    let found = records.iter().find(|record| {
                        record_file(record).as_deref() == Some(file.as_str())
                            && record_pending(record)
                    });
                    if found.is_none() {
                        target.send(error_event("That ADR is not pending."));
                        return Ok(());
                    }
                    found.cloned()
                } else {
                    let found = records
                        .iter()
                        .find(|record| record_file(record).as_deref() == next.as_str());
                    if found.is_none() {
                        if first && !quiet_empty {
                            target.send(error_event("No pending ADRs to start."));
                        }
                        return Ok(());
                    }
                    found.cloned()
                };
                let Some(record) = record else {
                    return Ok(());
                };
                first = false;
                if !lock(&self.inner).manual_sequencing {
                    return Ok(());
                }

                let conflict = {
                    let inner = lock(&self.inner);
                    inner.lifecycle_running
                        && inner.lifecycle.paused
                        && inner.lifecycle.stage == Stage::Adr
                        && inner.lifecycle.work.as_ref().is_some_and(|work| {
                            work.kind == WorkKind::Adr
                                && Some(work.id.as_str()) == record_file(&record).as_deref()
                        })
                };
                if conflict {
                    target.send(error_event("The lifecycle is already resolving that ADR."));
                    return Ok(());
                }

                let run = Arc::new(ManualRun::new(
                    record_file(&record).unwrap_or_default(),
                    record_title(&record),
                ));
                lock(&self.inner).manual_run = Some(Arc::clone(&run));
                app.shared.journal.write(
                    "run-start",
                    &format!("{}: {}", run.file, run.title),
                    None,
                );
                app.shared.broadcast(json!({
                    "type": "runStarted",
                    "file": run.file,
                    "title": run.title,
                    "action": run.action,
                    "manual": true,
                }));
                if !self.run_agent(app, Arc::clone(&run)).await {
                    return Ok(());
                }
            }
            Ok(())
        }
        .await;

        if let Err(message) = result {
            target.send(error_event(message));
        }

        let (queued_resume, paused_for_manual) = {
            let mut inner = lock(&self.inner);
            interrupted = !inner.manual_sequencing;
            inner.manual_sequencing = false;
            let queued = inner.resume_after_manual_sequence;
            inner.resume_after_manual_sequence = false;
            let paused_for_manual = inner.lifecycle_paused_for_manual_run;
            (queued, paused_for_manual)
        };
        if interrupted {
            lock(&self.inner).lifecycle_paused_for_manual_run = false;
        } else if paused_for_manual {
            lock(&self.inner).lifecycle_paused_for_manual_run = false;
            if self.is_running() && lock(&self.inner).lifecycle.paused {
                self.resume_lifecycle(app, target).await;
            }
        } else if queued_resume && self.is_running() && lock(&self.inner).lifecycle.paused {
            self.resume_lifecycle(app, target).await;
        }
        persist_now(app);
    }

    async fn resume_restored_manual_sequence(self: &Arc<Self>, app: &Arc<App>) {
        let run = lock(&self.inner).manual_run.clone();
        let Some(run) = run else {
            if !lock(&self.inner).manual_sequencing {
                return;
            }
            lock(&self.inner).manual_sequencing = false;
            let target = Target::Shared(Arc::clone(app));
            self.run_manual_sequence(app, &target, None, None, true)
                .await;
            return;
        };
        let pending = read_record(app, &run.file)
            .map(|record| record_pending(&record))
            .unwrap_or(false);
        let target = Target::Shared(Arc::clone(app));
        if pending {
            self.run_manual_sequence(app, &target, None, Some(run), true)
                .await;
            return;
        }
        lock(&self.inner).manual_run = None;
        persist_now(app);
        self.run_manual_sequence(app, &target, None, None, true)
            .await;
    }

    fn is_live_run(&self, run: &Arc<ManualRun>) -> bool {
        lock(&self.inner)
            .manual_run
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, run))
    }

    async fn run_agent(self: &Arc<Self>, app: &Arc<App>, run: Arc<ManualRun>) -> bool {
        let result: Result<Option<bool>, String> = async {
            let environment = app
                .providers
                .select_environment()
                .await
                .map_err(|error| error.message)?;
            if !self.is_live_run(&run) {
                return Ok(None);
            }
            let (connection, events) = connect_peer(app, environment).await?;
            if !self.is_live_run(&run) {
                connection.close();
                return Ok(None);
            }
            let connection = Arc::new(connection);
            *lock(&run.agent) = Some(Arc::clone(&connection));
            let prompt =
                crate::acp::agent_prompt(&app.config().adrs_dir.to_string_lossy(), &run.file);
            self.drive_manual_events(app, &run, events, &connection, &prompt)
                .await?;
            let record = read_record(app, &run.file);
            let resolved = record
                .as_ref()
                .is_some_and(|record| !record_pending(record));
            let status = record.as_ref().map(record_status).unwrap_or_default();
            Ok(Some(self.stop_run(app, &run, resolved, &status).await))
        }
        .await;

        match result {
            Ok(None) => false,
            Ok(Some(resolved)) => resolved,
            Err(message) => {
                if !self.is_live_run(&run) {
                    return false;
                }
                app.shared.broadcast(error_event(message.clone()));
                app.shared.journal.write("server-error", &message, None);
                let record = read_record(app, &run.file);
                let resolved = record
                    .as_ref()
                    .is_some_and(|record| !record_pending(record));
                let status = record.as_ref().map(record_status).unwrap_or_default();
                self.stop_run(app, &run, resolved, &status).await
            }
        }
    }

    async fn drive_manual_events(
        self: &Arc<Self>,
        app: &Arc<App>,
        run: &Arc<ManualRun>,
        mut events: mpsc::UnboundedReceiver<AcpEvent>,
        connection: &Arc<AcpConnection>,
        prompt: &str,
    ) -> Result<(), String> {
        let prompt_run = connection.run(prompt);
        tokio::pin!(prompt_run);
        let outcome = loop {
            tokio::select! {
                event = events.recv() => {
                    match event {
                        Some(event) => self.apply_manual_event(app, run, event),
                        None => break prompt_run.await,
                    }
                }
                result = &mut prompt_run => break result,
            }
        };
        while let Ok(event) = events.try_recv() {
            self.apply_manual_event(app, run, event);
        }
        outcome.map(|_| ()).map_err(|error| error.message)
    }

    fn apply_manual_event(self: &Arc<Self>, app: &Arc<App>, run: &Arc<ManualRun>, event: AcpEvent) {
        match event {
            AcpEvent::Activity(activity) => {
                if !self.is_live_run(run) {
                    return;
                }
                record_output(app, &run.activity, &activity, None);
            }
            AcpEvent::Question(question) => {
                app.shared.journal.write(
                    "question",
                    &question.message,
                    Some(&format!("run:{}", run.file)),
                );
                if !self.is_live_run(run) {
                    return;
                }
                let stored = store_question(&question);
                *lock(&run.question) = Some(stored.clone());
                app.shared.broadcast(json!({
                    "type": "question",
                    "id": stored.id,
                    "message": stored.message,
                    "options": stored.options,
                }));
            }
            AcpEvent::Stderr(text) => {
                app.shared.journal.write("acp-stderr", &text, None);
                eprint!("{text}");
            }
            AcpEvent::SessionUpdate | AcpEvent::Text(_) => {}
        }
    }

    async fn stop_run(
        self: &Arc<Self>,
        app: &Arc<App>,
        run: &Arc<ManualRun>,
        resolved: bool,
        status: &str,
    ) -> bool {
        let outcome = if !status.is_empty() {
            status.to_string()
        } else if resolved {
            "resolved".to_string()
        } else {
            "stopped".to_string()
        };
        {
            let mut inner = lock(&self.inner);
            match &inner.manual_run {
                Some(current) if Arc::ptr_eq(current, run) => {
                    inner.manual_run = None;
                    inner.last_manual_run = Some(finished_manual_run(run, resolved, status));
                }
                _ => return false,
            }
        }
        *lock(&run.question) = None;
        run.close_peer();
        app.shared
            .journal
            .write("run-stop", &format!("{}: {outcome}", run.file), None);
        app.shared.broadcast(json!({
            "type": "runStopped",
            "file": run.file,
            "title": run.title,
            "resolved": resolved,
            "status": status,
        }));
        match read_records(app) {
            Ok((records, next)) => {
                app.shared
                    .broadcast(json!({"type": "records", "records": records, "next": next}));
                resolved
            }
            Err(message) => {
                app.shared.broadcast(error_event(message));
                false
            }
        }
    }

    fn answer_question(
        self: &Arc<Self>,
        app: &Arc<App>,
        conn: &Conn,
        id: Option<&Value>,
        value: Option<&Value>,
        lane_id: Option<&Value>,
    ) -> bool {
        let lane = lane_id.and_then(Value::as_str).and_then(|id| {
            let inner = lock(&self.inner);
            inner.lanes.iter().find(|lane| lane.id == id).cloned()
        });
        let active = lock(&self.inner).manual_run.clone();
        let live = !lock(&self.inner).live.is_empty();
        if active.is_none() && lane.is_none() && !live {
            conn.send(error_event("No run is active."));
            return true;
        }

        let id = match id {
            Some(Value::String(text)) => text.clone(),
            Some(Value::Number(number)) => number.to_string(),
            _ => {
                conn.send(error_event(
                    "An answer needs the question id and a non-empty value.",
                ));
                return true;
            }
        };
        let value = value.and_then(Value::as_str);
        let Some(value) = value.filter(|value| !value.trim().is_empty()) else {
            conn.send(error_event(
                "An answer needs the question id and a non-empty value.",
            ));
            return true;
        };

        let deliver_lane = |lane: &Arc<Lane>| -> bool {
            let Some(question) = lane.question() else {
                return false;
            };
            if question.key() != id.as_str() {
                return false;
            }
            deliver_answer(
                app,
                conn.clone(),
                AnswerTarget::Lane(Arc::clone(lane)),
                question,
                value.to_string(),
                true,
            );
            true
        };

        if let Some(lane) = lane {
            if deliver_lane(&lane) {
                return true;
            }
            conn.send(error_event("No pending question with that id."));
            return true;
        }

        if let Some(run) = &active {
            if let Some(question) = run.question() {
                if question.key() == id.as_str() {
                    deliver_answer(
                        app,
                        conn.clone(),
                        AnswerTarget::Manual(Arc::clone(run)),
                        question,
                        value.to_string(),
                        false,
                    );
                    return true;
                }
            }
        }

        let matching = {
            let inner = lock(&self.inner);
            inner
                .live
                .values()
                .find(|lane| {
                    lane.question()
                        .is_some_and(|question| question.key() == id.as_str())
                })
                .cloned()
        };
        if let Some(lane) = matching {
            if deliver_lane(&lane) {
                return true;
            }
        }

        conn.send(error_event("No pending question with that id."));
        true
    }
}

enum AnswerTarget {
    Manual(Arc<ManualRun>),
    Lane(Arc<Lane>),
}

impl AnswerTarget {
    fn question(&self) -> Option<RunQuestion> {
        match self {
            Self::Manual(run) => run.question(),
            Self::Lane(lane) => lane.question(),
        }
    }

    fn agent(&self) -> Option<Arc<AcpConnection>> {
        match self {
            Self::Manual(run) => lock(&run.agent).clone(),
            Self::Lane(lane) => lock(&lane.agent).clone(),
        }
    }

    fn clear(&self) {
        match self {
            Self::Manual(run) => *lock(&run.question) = None,
            Self::Lane(lane) => *lock(&lane.question) = None,
        }
    }
}

/// Answers one held question, waiting for a peer the replay has not attached
/// yet rather than reporting a question that is still pending.
fn deliver_answer(
    app: &Arc<App>,
    conn: Conn,
    target: AnswerTarget,
    question: RunQuestion,
    value: String,
    publish: bool,
) {
    let app = Arc::clone(app);
    let target = Arc::new(target);
    tokio::spawn(async move {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(5_000);
        loop {
            let current = target.question();
            if current.as_ref() != Some(&question) {
                return;
            }
            if let Some(agent) = target.agent() {
                let Some(acp_id) = AcpId::from_value(&question.id) else {
                    conn.send(error_event("The question is no longer pending."));
                    return;
                };
                if agent.answer(&acp_id, &value).await {
                    if target.question().as_ref() == Some(&question) {
                        target.clear();
                        if publish {
                            if let Some(this) = state_for(&app) {
                                this.publish_lanes(&app);
                            }
                        }
                    }
                    return;
                }
                conn.send(error_event("The question is no longer pending."));
                return;
            }
            if tokio::time::Instant::now() >= deadline {
                conn.send(error_event("The question is no longer pending."));
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    });
}

// ---------------------------------------------------------------------------
// Implementation reset
// ---------------------------------------------------------------------------

impl GoalRun {
    /// Stops every operation this mode owns that can still touch the
    /// checkout. Nothing is published, so a caller inside a shared lock can
    /// run it; the caller publishes from outside that lock.
    fn stop_goal_work_silent(self: &Arc<Self>) -> (Option<Arc<ManualRun>>, bool) {
        {
            let mut inner = lock(&self.inner);
            inner.lifecycle_start_request = inner.lifecycle_start_request.wrapping_add(1);
            inner.lifecycle_paused_for_manual_run = false;
            inner.manual_start_request = inner.manual_start_request.wrapping_add(1);
            inner.manual_sequencing = false;
            inner.resume_after_manual_sequence = false;
        }
        self.abort_tracker_reads();
        let run = {
            let mut inner = lock(&self.inner);
            let run = inner.manual_run.take();
            if let Some(run) = &run {
                inner.last_manual_run = Some(finished_manual_run(run, false, ""));
            }
            run
        };
        if let Some(run) = &run {
            *lock(&run.question) = None;
            run.close_peer();
        }
        let running = self.is_running();
        let has_lanes = !lock(&self.inner).lanes.is_empty();
        if running {
            {
                let mut inner = lock(&self.inner);
                inner.lifecycle_running = false;
                inner.lifecycle = Lifecycle::idle(inner.lifecycle.pass);
            }
            self.clear_lane_state_silent();
        } else if has_lanes {
            self.clear_lane_state_silent();
        }
        self.notify_resume();
        (run, running || has_lanes)
    }

    fn publish_manual_stopped(app: &Arc<App>, run: &Arc<ManualRun>) {
        app.shared.broadcast(json!({
            "type": "runStopped",
            "file": run.file,
            "title": run.title,
            "resolved": false,
            "status": "",
        }));
    }

    /// Stops this mode's work and publishes it, outside every shared lock.
    fn abort_goal_work(self: &Arc<Self>, app: &Arc<App>) {
        let (run, changed) = self.stop_goal_work_silent();
        if let Some(run) = &run {
            Self::publish_manual_stopped(app, run);
        }
        if changed {
            self.publish_lanes(app);
            self.publish_lifecycle(app, false);
        }
    }

    /// The gate form: a gate is called with the registry lock held, so the
    /// frames leave from a task that runs after the caller releases it.
    fn abort_goal_work_after_lock(self: &Arc<Self>, app: &Arc<App>) {
        let (run, changed) = self.stop_goal_work_silent();
        let this = Arc::clone(self);
        let app = Arc::clone(app);
        tokio::spawn(async move {
            if let Some(run) = &run {
                Self::publish_manual_stopped(&app, run);
            }
            if changed {
                this.publish_lanes(&app);
                this.publish_lifecycle(&app, false);
            }
        });
    }

    /// Ends the work a reset preempts: this mode's own runs, goal authoring,
    /// and Discover. Flow, Issues, and Agents keep their work exactly as the
    /// TypeScript reset leaves them.
    fn stop_active_work_for_reset(self: &Arc<Self>, app: &Arc<App>) {
        app.shared.abort_gate("discover");
        app.shared.abort_gate("goal-authoring");
        self.abort_goal_work(app);
    }

    fn start_implementation_reset(self: &Arc<Self>, app: &Arc<App>, target: &Target) {
        if lock(&self.inner).reset_active {
            target.send(error_event("An implementation reset is active."));
            return;
        }
        if crate::flow_mode::has_unmerged_session(app) {
            target.send(error_event(
                "A Flow session is not merged. Merge it before resetting the implementation.",
            ));
            return;
        }
        {
            let mut inner = lock(&self.inner);
            inner.reset_active = true;
        }
        app.shared
            .broadcast(json!({"type": "implementationResetStarted"}));
        let this = Arc::clone(self);
        let app = Arc::clone(app);
        tokio::spawn(async move {
            this.perform_implementation_reset(&app).await;
        });
    }

    async fn perform_implementation_reset(self: &Arc<Self>, app: &Arc<App>) {
        let repo = app.config().repo_dir.clone();
        let state_dir = app.config().state_dir.clone();
        let goal_file = app.config().goal_file.clone();
        let empty = HashMap::new();

        let top = crate::git::run_git(
            &repo,
            &["rev-parse", "--show-toplevel"],
            &empty,
            GIT_TIMEOUT_MS,
        )
        .await;
        if top.code != 0
            || crate::detached_run::absolute(Path::new(top.stdout.trim()))
                != crate::detached_run::absolute(&repo)
        {
            self.fail_reset(
                app,
                &format!(
                    "Reset refused: REPO_DIR is not the repository top level. {}",
                    git_detail(&top)
                ),
                None,
            );
            return;
        }

        let head = crate::git::run_git(
            &repo,
            &["rev-parse", "--verify", "HEAD"],
            &empty,
            GIT_TIMEOUT_MS,
        )
        .await;
        if head.code != 0 {
            self.fail_reset(
                app,
                &format!(
                    "Reset refused: HEAD does not name a commit. {}",
                    git_detail(&head)
                ),
                None,
            );
            return;
        }

        let branch = crate::git::run_git(
            &repo,
            &["symbolic-ref", "--short", "HEAD"],
            &empty,
            GIT_TIMEOUT_MS,
        )
        .await;
        if branch.code != 0 || branch.stdout.trim() != "main" {
            self.fail_reset(
                app,
                &format!(
                    "Reset refused: the repository is not on main. {}",
                    git_detail(&branch)
                ),
                None,
            );
            return;
        }

        let origin = crate::git::run_git(
            &repo,
            &["remote", "get-url", "origin"],
            &empty,
            GIT_TIMEOUT_MS,
        )
        .await;
        if origin.code != 0 {
            self.fail_reset(
                app,
                &format!(
                    "Reset refused: the repository has no origin remote. {}",
                    git_detail(&origin)
                ),
                None,
            );
            return;
        }

        let state_path = match reset_state_path(&repo, &state_dir) {
            ResetStatePath::Root => {
                self.fail_reset(
                    app,
                    "Reset refused: STATE_DIR is the repository root, which the reset would \
delete.",
                    None,
                );
                return;
            }
            ResetStatePath::Outside => None,
            ResetStatePath::Inside(path) => Some(path),
        };
        if let Some(path) = &state_path {
            if let Err(message) = exclude_reset_state(&repo, path).await {
                self.fail_reset(app, &format!("Reset failed: {message}"), None);
                return;
            }
        }

        self.stop_active_work_for_reset(app);

        let keep = reset_keep_set(&repo, &goal_file);
        let entries = match std::fs::read_dir(&repo) {
            Ok(entries) => entries,
            Err(error) => {
                self.fail_reset(app, &format!("Reset failed: {error}"), None);
                return;
            }
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if keep.contains(name.as_str()) || RESET_INTERNAL_NAMES.contains(&name.as_str()) {
                continue;
            }
            let target = repo.join(&name);
            if let Some(state_path) = &state_path {
                if state_path == Path::new(&name) {
                    continue;
                }
                let prefix = Path::new(&name);
                if let Ok(rest) = state_path.strip_prefix(prefix) {
                    let rest: Vec<String> = rest
                        .components()
                        .map(|component| component.as_os_str().to_string_lossy().into_owned())
                        .collect();
                    if let Err(error) = clear_except_reset_state(&target, &rest) {
                        self.fail_reset(app, &format!("Reset failed: {error}"), None);
                        return;
                    }
                    continue;
                }
            }
            if let Err(error) = remove_reset_target(&target) {
                self.fail_reset(app, &format!("Reset failed: {error}"), None);
                return;
            }
        }

        let staged = crate::git::run_git(&repo, &["add", "-A"], &empty, GIT_TIMEOUT_MS).await;
        if staged.code != 0 {
            self.fail_reset(
                app,
                &format!("Could not stage the reset: {}", git_detail(&staged)),
                None,
            );
            return;
        }
        let mut rm_args: Vec<String> = vec![
            "rm".into(),
            "-r".into(),
            "--cached".into(),
            "--ignore-unmatch".into(),
            "-q".into(),
            "--".into(),
        ];
        for name in RESET_STAGE_EXCLUSIONS {
            rm_args.push(name.to_string());
        }
        if let Some(path) = &state_path {
            rm_args.push(path.to_string_lossy().into_owned());
        }
        let rm_refs: Vec<&str> = rm_args.iter().map(String::as_str).collect();
        let excluded = crate::git::run_git(&repo, &rm_refs, &empty, GIT_TIMEOUT_MS).await;
        if excluded.code != 0 {
            self.fail_reset(
                app,
                &format!("Could not stage the reset: {}", git_detail(&excluded)),
                None,
            );
            return;
        }

        let changed = crate::git::run_git(
            &repo,
            &["diff", "--cached", "--quiet"],
            &empty,
            GIT_TIMEOUT_MS,
        )
        .await;
        if changed.code != 0 {
            let committed = crate::git::run_git(
                &repo,
                &["commit", "--no-verify", "-m", RESET_COMMIT_MESSAGE],
                &empty,
                GIT_TIMEOUT_MS,
            )
            .await;
            if committed.code != 0 {
                self.fail_reset(
                    app,
                    &format!("Could not commit the reset: {}", git_detail(&committed)),
                    None,
                );
                return;
            }
        }

        let committed_head =
            crate::git::run_git(&repo, &["rev-parse", "HEAD"], &empty, GIT_TIMEOUT_MS).await;
        if committed_head.code != 0 {
            self.fail_reset(
                app,
                &format!(
                    "Could not read the reset commit: {}",
                    git_detail(&committed_head)
                ),
                None,
            );
            return;
        }
        let commit = committed_head.stdout.trim().to_string();

        let mut push_env = HashMap::new();
        push_env.insert("GIT_TERMINAL_PROMPT".to_string(), "0".to_string());
        push_env.insert("GIT_ASKPASS".to_string(), "true".to_string());
        push_env.insert("NO_COLOR".to_string(), "1".to_string());
        let pushed = crate::git::run_git(
            &repo,
            &["push", "origin", "main"],
            &push_env,
            GIT_TIMEOUT_MS,
        )
        .await;
        if pushed.code != 0 {
            self.fail_reset(
                app,
                &format!("Could not push the reset commit: {}", git_detail(&pushed)),
                Some(&commit),
            );
            return;
        }

        let text = tokio::fs::read_to_string(&goal_file)
            .await
            .unwrap_or_default();
        {
            let mut inner = lock(&self.inner);
            inner.reset_active = false;
            inner.lifecycle = Lifecycle::idle(1);
            inner.last_lifecycle = Some(inner.lifecycle.clone());
        }
        app.shared.broadcast(json!({
            "type": "implementationResetStopped",
            "completed": true,
            "commit": commit,
        }));
        // The reset owns the frame: it always tells every page the pass is back
        // at goal, even though the durable last state already says so.
        self.publish_lifecycle(app, true);
        app.shared
            .broadcast(json!({"type": "records", "records": [], "next": null}));
        app.shared.broadcast(json!({"type": "goal", "text": text}));
    }

    fn fail_reset(self: &Arc<Self>, app: &Arc<App>, message: &str, commit: Option<&str>) {
        lock(&self.inner).reset_active = false;
        app.shared.broadcast(error_event(message));
        let mut frame = json!({"type": "implementationResetStopped", "completed": false});
        if let Some(commit) = commit {
            frame["commit"] = json!(commit);
        }
        app.shared.broadcast(frame);
    }
}

enum ResetStatePath {
    Root,
    Outside,
    Inside(PathBuf),
}

fn reset_state_path(repo: &Path, state_dir: &Path) -> ResetStatePath {
    let repo = crate::detached_run::absolute(repo);
    let state_dir = crate::detached_run::absolute(state_dir);
    match state_dir.strip_prefix(&repo) {
        Ok(rest) if rest.as_os_str().is_empty() => ResetStatePath::Root,
        Ok(rest) => ResetStatePath::Inside(rest.to_path_buf()),
        Err(_) => ResetStatePath::Outside,
    }
}

/// The exact top-level names a reset keeps, plus a differently named goal file.
fn reset_keep_set(repo: &Path, goal_file: &Path) -> HashSet<String> {
    let mut names: HashSet<String> = RESET_KEEP_NAMES
        .iter()
        .map(|name| name.to_string())
        .collect();
    let goal = crate::detached_run::absolute(goal_file);
    let repo = crate::detached_run::absolute(repo);
    if goal.parent() == Some(repo.as_path()) {
        if let Some(name) = goal
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
        {
            if name != "GOAL.md" {
                names.insert(name);
            }
        }
    }
    names
}

/// Marks an in-repo state directory ignored in this checkout, so the reset
/// stages none of it and every byte stays.
async fn exclude_reset_state(repo: &Path, state_path: &Path) -> Result<(), String> {
    let result = crate::git::run_git(
        repo,
        &["rev-parse", "--git-path", "info/exclude"],
        &HashMap::new(),
        GIT_TIMEOUT_MS,
    )
    .await;
    if result.code != 0 {
        return Err(format!(
            "could not locate the git exclude file: {}",
            git_detail(&result)
        ));
    }
    let file = repo.join(result.stdout.trim());
    if let Some(parent) = file.parent() {
        if let Err(error) = std::fs::create_dir_all(parent) {
            return Err(error.to_string());
        }
    }
    let existing = match std::fs::read_to_string(&file) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.to_string()),
    };
    let pattern = format!(
        "/{}/",
        state_path
            .components()
            .map(|component| component.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/")
    );
    let lines: Vec<&str> = existing
        .split('\n')
        .map(|line| line.trim_end_matches('\r'))
        .collect();
    if lines.contains(&pattern.as_str()) {
        return Ok(());
    }
    let separator = if existing.is_empty() || existing.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    let comment = if lines.contains(&RESET_STATE_EXCLUDE_COMMENT) {
        ""
    } else {
        "# Devboard state directory\n"
    };
    std::fs::write(&file, format!("{existing}{separator}{comment}{pattern}\n"))
        .map_err(|error| error.to_string())
}

/// Removes one reset target, unlinking a symlink instead of following it.
fn remove_reset_target(path: &Path) -> std::io::Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    } else {
        match std::fs::remove_dir_all(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }
}

/// Clears one top-level entry while preserving the chain down to a nested
/// state directory.
fn clear_except_reset_state(target: &Path, keep: &[String]) -> std::io::Result<()> {
    let Some((next, rest)) = keep.split_first() else {
        return Ok(());
    };
    for entry in std::fs::read_dir(target)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if &name == next {
            let is_symlink = entry.file_type()?.is_symlink();
            if !rest.is_empty() && !is_symlink {
                clear_except_reset_state(&entry.path(), rest)?;
            }
            continue;
        }
        remove_reset_target(&entry.path())?;
    }
    Ok(())
}

fn git_detail(result: &crate::git::GitResult) -> String {
    let detail = if result.stderr.trim().is_empty() {
        result.stdout.trim()
    } else {
        result.stderr.trim()
    };
    if detail.is_empty() {
        format!("git exited with code {}", result.code)
    } else {
        detail.to_string()
    }
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

/// Finds every open epic on the origin tracker. An issue is an epic when it is
/// open and either carries the label `epic` ignoring case or contains the
/// `devboard-epic` marker in its body.
async fn find_open_epics(repo_dir: &Path, timeout_ms: u64) -> Result<Vec<Epic>, String> {
    let deadline = now_millis() + timeout_ms;
    let remote = crate::git::run_git(
        repo_dir,
        &["remote", "get-url", "origin"],
        &HashMap::new(),
        timeout_ms.max(1),
    )
    .await;
    if remote.code != 0 {
        let detail = if remote.stderr.trim().is_empty() {
            format!("exit code {}", remote.code)
        } else {
            remote.stderr.trim().to_string()
        };
        return Err(format!("Could not read the origin remote: {detail}"));
    }
    let environment = forge::process_environment();
    let classified = forge::parse_forge_remote(remote.stdout.trim(), &environment)
        .ok_or_else(|| "The origin remote does not name a supported repository.".to_string())?;

    let remaining = || deadline.saturating_sub(now_millis()).max(1);
    match classified.forge {
        Forge::Gitea => gitea_epics(&classified, &environment, remaining()).await,
        Forge::GitHub | Forge::GitLab => {
            let exec = forge::default_exec();
            let auth = forge::resolve_forge_auth(
                &exec,
                &ResolveOptions {
                    forge: classified.forge,
                    host: classified.host.clone(),
                    project: classified.project.clone(),
                    cwd: repo_dir.to_path_buf(),
                    required: RequiredAccess::Read,
                    env: environment.clone(),
                    deadline_ms: Some(deadline as i64),
                    base_url: None,
                    gitea_transport: None,
                },
            )
            .await
            .into_result()
            .map_err(|failure| failure.error)?;
            let env =
                forge::auth_environment(&auth, &environment).map_err(|error| error.message)?;
            if classified.forge == Forge::GitHub {
                github_epics(&exec, repo_dir, &classified.project, &env, remaining()).await
            } else {
                gitlab_epics(&exec, repo_dir, &env, remaining()).await
            }
        }
    }
}

async fn gitea_epics(
    remote: &forge::ForgeRemote,
    environment: &Environment,
    timeout_ms: u64,
) -> Result<Vec<Epic>, String> {
    let target = forge::gitea_target(
        Some(remote),
        Some(remote.project.as_str()),
        None,
        None,
        environment,
    )
    .map_err(|error| error.message)?;
    let transport = forge::default_transport(timeout_ms);
    let options = forge::GiteaCallOptions {
        flow_id: None,
        timeout_ms: Some(timeout_ms),
    };
    let issues = forge::gitea_list_issues(&target, IssueQueryState::Open, &transport, &options)
        .await
        .map_err(|error| error.message)?;
    Ok(issues
        .into_iter()
        .filter(|issue| {
            issue
                .labels
                .iter()
                .any(|label| label.to_lowercase() == "epic")
                || issue.body.contains("devboard-epic")
        })
        .map(|issue| Epic {
            number: issue.number,
            title: issue.title,
            url: issue.url,
        })
        .collect())
}

async fn command_json(
    exec: &Exec,
    cwd: &Path,
    argv: &[&str],
    environment: &Environment,
    timeout_ms: u64,
    description: &str,
) -> Result<Value, String> {
    let result = exec(
        argv[0].to_string(),
        argv[1..].iter().map(|arg| arg.to_string()).collect(),
        ExecOptions {
            cwd: Some(cwd.to_path_buf()),
            env: environment.clone(),
            timeout_ms: Some(timeout_ms.max(1)),
            stdin: None,
        },
    )
    .await;
    if result.code != 0 {
        let detail = if !result.stderr.trim().is_empty() {
            result.stderr.trim().to_string()
        } else if !result.stdout.trim().is_empty() {
            result.stdout.trim().to_string()
        } else {
            format!("exit code {}", result.code)
        };
        return Err(format!("Could not {description}: {detail}"));
    }
    let source = result.stdout.trim();
    if source.is_empty() {
        return Ok(Value::Array(Vec::new()));
    }
    serde_json::from_str(source)
        .map_err(|_| format!("Could not {description}: unexpected CLI output."))
}

async fn github_epics(
    exec: &Exec,
    cwd: &Path,
    project: &str,
    environment: &Environment,
    timeout_ms: u64,
) -> Result<Vec<Epic>, String> {
    let labels = command_json(
        exec,
        cwd,
        &[
            "gh", "label", "list", "--search", "epic", "--limit", "100", "--json", "name",
        ],
        environment,
        timeout_ms,
        "list tracker labels",
    )
    .await?;
    let label = labels
        .as_array()
        .and_then(|entries| {
            entries.iter().find(|entry| {
                entry
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| name.to_lowercase() == "epic")
            })
        })
        .and_then(|entry| entry.get("name").and_then(Value::as_str))
        .map(str::to_string);

    let body = command_json(
        exec,
        cwd,
        &[
            "gh",
            "search",
            "issues",
            "--repo",
            project,
            "--match",
            "body",
            "--state",
            "open",
            "devboard-epic",
            "--json",
            "number,title,url",
            "--limit",
            "100",
        ],
        environment,
        timeout_ms,
        "search open epics",
    )
    .await?;
    let body_epics = all_epics(&body);
    let Some(label) = label else {
        return Ok(body_epics);
    };
    let labelled = command_json(
        exec,
        cwd,
        &[
            "gh",
            "issue",
            "list",
            "--label",
            &label,
            "--state",
            "open",
            "--json",
            "number,title,url",
            "--limit",
            "100",
        ],
        environment,
        timeout_ms,
        "list open epics",
    )
    .await?;
    Ok(union_epics([all_epics(&labelled), body_epics]))
}

async fn gitlab_epics(
    exec: &Exec,
    cwd: &Path,
    environment: &Environment,
    timeout_ms: u64,
) -> Result<Vec<Epic>, String> {
    let labels = command_json(
        exec,
        cwd,
        &["glab", "label", "list", "--output", "json"],
        environment,
        timeout_ms,
        "list tracker labels",
    )
    .await?;
    let label = labels
        .as_array()
        .and_then(|entries| {
            entries.iter().find(|entry| {
                entry
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| name.to_lowercase() == "epic")
            })
        })
        .and_then(|entry| entry.get("name").and_then(Value::as_str))
        .map(str::to_string);

    let body = command_json(
        exec,
        cwd,
        &[
            "glab",
            "issue",
            "list",
            "--search",
            "devboard-epic",
            "--in",
            "description",
            "--output",
            "json",
        ],
        environment,
        timeout_ms,
        "search open epics",
    )
    .await?;
    let body_epics = all_epics(&body);
    let Some(label) = label else {
        return Ok(body_epics);
    };
    let labelled = command_json(
        exec,
        cwd,
        &[
            "glab", "issue", "list", "--label", &label, "--output", "json",
        ],
        environment,
        timeout_ms,
        "list open epics",
    )
    .await?;
    Ok(union_epics([all_epics(&labelled), body_epics]))
}

fn all_epics(value: &Value) -> Vec<Epic> {
    let Some(entries) = value.as_array() else {
        return Vec::new();
    };
    let mut epics = Vec::new();
    for entry in entries {
        let number = entry
            .get("number")
            .and_then(Value::as_i64)
            .or_else(|| entry.get("iid").and_then(Value::as_i64));
        let title = entry.get("title").and_then(Value::as_str);
        let (Some(number), Some(title)) = (number, title) else {
            continue;
        };
        let url = entry
            .get("url")
            .and_then(Value::as_str)
            .or_else(|| entry.get("web_url").and_then(Value::as_str))
            .unwrap_or("");
        epics.push(Epic {
            number,
            title: title.to_string(),
            url: url.to_string(),
        });
    }
    epics
}

fn union_epics(groups: [Vec<Epic>; 2]) -> Vec<Epic> {
    let mut merged: Vec<Epic> = Vec::new();
    for group in groups {
        for epic in group {
            if !merged.iter().any(|entry| entry.number == epic.number) {
                merged.push(epic);
            }
        }
    }
    merged
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

fn refuse_flow(app: &Arc<App>, target: &Target) -> bool {
    if !app.shared.gate_active("flow") {
        return false;
    }
    target.send(error_event(
        "Flow Mode is active. Finish or stop its work first.",
    ));
    true
}

fn refuse_discover(app: &Arc<App>, target: &Target) -> bool {
    if !app.shared.gate_active("discover") {
        return false;
    }
    let message = app.shared.gate_reason("discover").unwrap_or_else(|| {
        "A Discover run is active. Finish or stop it before starting other work.".to_string()
    });
    target.send(error_event(message));
    true
}

/// The first of the caller's refusal messages whose authoring work is live.
fn authoring_refusal(app: &Arc<App>, messages: &[&str; 3]) -> Option<String> {
    if !app.shared.gate_active("goal-authoring") {
        return None;
    }
    let reason = app.shared.gate_reason("goal-authoring").unwrap_or_default();
    let lower = reason.to_lowercase();
    let index = if lower.contains("preparation") {
        0
    } else if lower.contains("creation") {
        1
    } else if lower.contains("revision") {
        2
    } else {
        1
    };
    Some(messages[index].to_string())
}

// ---------------------------------------------------------------------------
// Records, activity, peers
// ---------------------------------------------------------------------------

fn read_records(app: &Arc<App>) -> Result<(Vec<Value>, Value), String> {
    crate::records::read_records(&app.config().adrs_dir)
}

fn read_record(app: &Arc<App>, file: &str) -> Option<Value> {
    read_records(app).ok().and_then(|(records, _)| {
        records
            .into_iter()
            .find(|record| record_file(record).as_deref() == Some(file))
    })
}

fn record_file(record: &Value) -> Option<String> {
    record
        .get("file")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn record_title(record: &Value) -> String {
    record
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn record_pending(record: &Value) -> bool {
    record.get("pending").and_then(Value::as_bool) == Some(true)
}

fn record_status(record: &Value) -> String {
    record
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn pending_file(record: &Value) -> Option<String> {
    record_pending(record)
        .then(|| record_file(record))
        .flatten()
}

/// Streamed deltas extend the last activity line; a new message, tool call, or
/// plan starts one.
fn record_output(
    app: &Arc<App>,
    store: &Mutex<Vec<String>>,
    activity: &AcpActivity,
    lane: Option<&str>,
) {
    app.shared.journal.write("activity", &activity.text, None);
    let append = activity.append && !lock(store).is_empty();
    {
        let mut lines = lock(store);
        if append {
            if let Some(last) = lines.last_mut() {
                last.push_str(&activity.text);
            }
        } else {
            lines.push(activity.text.clone());
        }
        trim_activity(&mut lines);
    }
    let mut frame = json!({"type": "activity", "text": activity.text});
    if append {
        frame["append"] = json!(true);
    }
    if let Some(lane) = lane {
        frame["lane"] = json!(lane);
    }
    app.shared.broadcast(frame);
}

fn store_question(question: &AcpQuestion) -> RunQuestion {
    RunQuestion {
        id: match &question.id {
            AcpId::Number(number) => json!(number),
            AcpId::String(text) => json!(text),
        },
        message: question.message.clone(),
        options: serde_json::to_value(&question.options)
            .ok()
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default(),
    }
}

/// One peer started with the same command, cwd, environment, and permission
/// policy every Devboard peer uses.
async fn connect_peer(
    app: &Arc<App>,
    environment: HashMap<String, Option<String>>,
) -> Result<(AcpConnection, mpsc::UnboundedReceiver<AcpEvent>), String> {
    let env: HashMap<String, String> = environment
        .into_iter()
        .filter_map(|(key, value)| value.map(|value| (key, value)))
        .collect();
    let options = AcpConnectionOptions::new(
        app.config().agent_command.clone(),
        app.config().repo_dir.to_string_lossy().into_owned(),
    )
    .with_starter("Goal")
    .with_env(env)
    .with_permission_policy(PermissionPolicy::Allow);
    AcpConnection::connect(options)
        .await
        .map_err(|error| error.message)
}

/// Counts the managed skills a lifecycle start requires.
async fn prepared_skill_count(app: &Arc<App>) -> Result<usize, String> {
    let root = crate::installed_skills::skills_root(&app.config().repo_dir);
    let mut reader = match tokio::fs::read_dir(&root).await {
        Ok(reader) => reader,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error.to_string()),
    };
    let mut count = 0;
    while let Some(entry) = reader
        .next_entry()
        .await
        .map_err(|error| error.to_string())?
    {
        // A link is the operator's entry, whatever marker its target carries.
        if entry
            .file_type()
            .await
            .map_err(|error| error.to_string())?
            .is_symlink()
        {
            continue;
        }
        let path = entry.path().join("SKILL.md");
        let Ok(source) = tokio::fs::read_to_string(&path).await else {
            continue;
        };
        if frontmatter_field(&source, "metadata.devboard-managed").as_deref() == Some("true") {
            count += 1;
        }
    }
    Ok(count)
}

fn frontmatter_field(source: &str, key: &str) -> Option<String> {
    let mut lines = source.split('\n');
    if lines.next()?.trim() != "---" {
        return None;
    }
    let mut section: Option<String> = None;
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        let indented = line.starts_with(' ') || line.starts_with('\t');
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((name, value)) = trimmed.split_once(':') else {
            continue;
        };
        let name = name.trim();
        let value = unquote(value.trim());
        if !indented {
            section = None;
            if !name.contains('.') && value.is_empty() {
                section = Some(name.to_string());
                continue;
            }
            if name == key {
                return Some(value);
            }
            continue;
        }
        if let Some(current) = &section {
            if format!("{current}.{name}") == key {
                return Some(value);
            }
        }
    }
    None
}

fn unquote(value: &str) -> String {
    let value = value.trim();
    let value = value
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .unwrap_or(value);
    value
        .strip_prefix('\'')
        .and_then(|rest| rest.strip_suffix('\''))
        .unwrap_or(value)
        .to_string()
}

fn trim_activity(store: &mut Vec<String>) {
    if activity_within_bounds(store) {
        return;
    }
    let marker_bytes = ACTIVITY_TRIMMED_MARKER.len();
    let mut kept: Vec<String> = Vec::new();
    let mut bytes = marker_bytes;
    for line in store.iter().rev() {
        let size = line.len();
        let entries = kept.len() + 2;
        if !kept.is_empty() && (entries > ACTIVITY_MAX_ENTRIES || bytes + size > ACTIVITY_MAX_BYTES)
        {
            break;
        }
        kept.insert(0, line.clone());
        bytes += size;
    }
    store.clear();
    store.push(ACTIVITY_TRIMMED_MARKER.to_string());
    store.extend(kept);
}

fn activity_within_bounds(store: &[String]) -> bool {
    if store.len() > ACTIVITY_MAX_ENTRIES {
        return false;
    }
    let mut bytes = 0;
    for line in store {
        bytes += line.len();
        if bytes > ACTIVITY_MAX_BYTES {
            return false;
        }
    }
    true
}

/// Writes the state directly, as `persistState` does before a peer starts.
/// Each write stages beside the file under a path of its own, so a concurrent
/// broadcast cannot interleave bytes with it.
fn persist_now(app: &Arc<App>) {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let text = crate::state::state_envelope(&app.shared.state_value());
    let path = app.shared.state_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = PathBuf::from(format!(
        "{}.{}.{}.tmp",
        path.display(),
        std::process::id(),
        sequence
    ));
    if std::fs::write(&temporary, text).is_ok() {
        let _ = std::fs::rename(&temporary, path);
    } else {
        let _ = std::fs::remove_file(&temporary);
    }
}

fn app_of(owner: &Arc<GoalRun>) -> Arc<App> {
    owner
        .app
        .get()
        .and_then(Weak::upgrade)
        .unwrap_or_else(|| unreachable!("the application outlives its modes"))
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
