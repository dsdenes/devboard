//! Goal authoring: guided creation, revision, and skills preparation.
//!
//! Ported from `.devboard/server/app.ts`: each flow owns one ACP peer, records
//! its activity and pending question, and reports the goal document or the
//! prepared skills when the turn ends. The durable state keys are
//! `goalCreation`, `goalRevision`, `skillsPreparation`, and
//! `skillsPreparationPending`.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, OnceLock, Weak};

use base64::Engine as _;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;

use crate::acp::{
    AcpActivity, AcpConnection, AcpConnectionOptions, AcpEvent, AcpId, AcpQuestionOption,
    PermissionPolicy,
};
use crate::app::{App, Conn, ModeGate, StateSection};
use crate::command::Command;
use crate::goal_run::question_cleared_event;
use crate::skill_frontmatter;
use crate::state::{ACTIVITY_MAX_BYTES, ACTIVITY_MAX_ENTRIES, ACTIVITY_TRIMMED_MARKER};

/// The prompt a creation peer receives.
const GOAL_CREATION_PROMPT: &str = "/goal-outcome";
/// The prompt a skills preparation peer receives.
const SKILLS_PROMPT: &str = "/prepare-skills";
/// The longest skill name OMP accepts.
const SKILL_NAME_MAX: usize = 64;
/// The longest skill description accepted.
const SKILL_DESCRIPTION_MAX: usize = 1024;
/// The frontmatter field marking a skill this feature wrote itself.
const MANAGED_MARKER: &str = "devboard-managed";
/// The frontmatter field marking a skill the package ships.
const BUILTIN_MARKER: &str = "devboard-builtin";
/// The frontmatter field naming a managed skill's family.
const FAMILY_FIELD: &str = "metadata.devboard-family";
/// The six skills Discover owns.
const DISCOVER_SKILLS: [&str; 6] = [
    "discover-testing-strategy",
    "discover-naming-conventions",
    "discover-coding-conventions",
    "discover-architecture-boundaries",
    "discover-glossary",
    "discover-contribution",
];

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/// Registers this mode's durable state with the dashboard.
pub fn init(app: &Arc<App>) {
    let owner = Arc::new(GoalAuthoring {
        app: OnceLock::new(),
        inner: Mutex::new(Inner::default()),
        resume_scheduled: AtomicBool::new(false),
    });
    let _ = owner.app.set(Arc::downgrade(app));
    for (key, field) in [
        ("goalCreation", Field::Creation),
        ("goalRevision", Field::Revision),
        ("skillsPreparation", Field::Preparation),
        ("skillsPreparationPending", Field::Pending),
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
        "goal-authoring",
        Arc::new(AuthoringGate {
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
struct AuthoringGate {
    owner: Weak<GoalAuthoring>,
}

impl ModeGate for AuthoringGate {
    fn has_active_work(&self) -> bool {
        let Some(owner) = self.owner.upgrade() else {
            return false;
        };
        let inner = lock(&owner.inner);
        inner.creation.is_some()
            || inner.revision.is_some()
            || inner.preparation.is_some()
            || inner.preparation_pending
    }

    fn busy_reason(&self) -> Option<String> {
        let owner = self.owner.upgrade()?;
        let inner = lock(&owner.inner);
        if inner.creation.is_some() {
            Some("A goal creation is active.".to_string())
        } else if inner.revision.is_some() {
            Some("A goal revision is active.".to_string())
        } else if inner.preparation.is_some() || inner.preparation_pending {
            Some("Skills preparation is active.".to_string())
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
        owner.abort_everything(&app);
    }
}

/// Replays the frames a connecting client owes before its own replies.
pub fn replay(app: &Arc<App>, conn: &Conn) {
    let Some(this) = state_for(app) else {
        return;
    };
    let (creation, revision, preparation) = {
        let inner = lock(&this.inner);
        (
            inner.creation.clone(),
            inner.revision.clone(),
            inner.preparation.clone(),
        )
    };
    if let Some(owner) = creation {
        // The snapshot is authoritative for the question: a page keeps the
        // prompt and its draft until a read proves the answer landed, and a
        // poll after an accepted answer carries no question.
        conn.send(json!({"type": "goalCreationStarted", "question": owner.question_json()}));
        for text in owner.activity() {
            conn.send(json!({"type": "activity", "text": text}));
        }
        if let Some(question) = owner.question() {
            conn.send(question.frame());
        }
    }
    if let Some(owner) = revision {
        conn.send(json!({"type": "goalRevisionStarted", "question": owner.question_json()}));
        for text in owner.activity() {
            conn.send(json!({"type": "activity", "text": text}));
        }
        if let Some(question) = owner.question() {
            conn.send(question.frame());
        }
    }
    if let Some(preparation) = preparation {
        conn.send(json!({
            "type": "skillsPreparationStarted",
            "question": preparation.owner.question_json(),
        }));
        for text in preparation.owner.activity() {
            conn.send(json!({"type": "activity", "text": text}));
        }
        if let Some(question) = preparation.owner.question() {
            conn.send(question.frame());
        }
    }
}

/// Applies one command; `false` when it belongs to another mode.
pub async fn handle(app: &Arc<App>, conn: &Conn, command: &Command) -> bool {
    let Some(this) = state_for(app) else {
        return false;
    };
    match command {
        Command::CreateGoal => {
            this.start_creation(app, &Target::Conn(conn.clone())).await;
            true
        }
        Command::ReviseGoal { request } => {
            this.start_revision(app, &Target::Conn(conn.clone()), request.as_ref())
                .await;
            true
        }
        Command::PrepareSkills => {
            this.start_preparation(app, &Target::Conn(conn.clone()), None)
                .await;
            true
        }
        Command::GetSkills => {
            replay(app, conn);
            send_skills_state(app, &Target::Conn(conn.clone())).await;
            true
        }
        Command::DeleteSkill { name } => {
            delete_skill(app, &Target::Conn(conn.clone()), name.as_ref()).await;
            true
        }
        Command::Answer { id, value, lane } => {
            this.answer_question(conn, id.as_ref(), value.as_ref(), lane.as_ref())
        }
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Durable state
// ---------------------------------------------------------------------------

/// The state a dashboard restores from and writes.
#[derive(Default)]
struct GoalAuthoring {
    app: OnceLock<Weak<App>>,
    inner: Mutex<Inner>,
    /// One resume task is scheduled per restore, never one per section.
    resume_scheduled: AtomicBool,
}

#[derive(Default)]
struct Inner {
    creation: Option<Arc<Owner>>,
    revision: Option<Arc<Owner>>,
    revision_request: Option<String>,
    creation_request: u64,
    preparation: Option<Arc<SkillsOwner>>,
    preparation_pending: bool,
    pending_skills: Option<PendingSkills>,
    preparation_request: u64,
}

/// One peer's replayable conversation.
struct Owner {
    activity: Mutex<Vec<String>>,
    question: Mutex<Option<RunQuestion>>,
    agent: Mutex<Option<Arc<AcpConnection>>>,
}

impl Owner {
    fn new() -> Self {
        Self {
            activity: Mutex::new(Vec::new()),
            question: Mutex::new(None),
            agent: Mutex::new(None),
        }
    }

    fn restored(activity: Vec<String>, question: Option<RunQuestion>) -> Self {
        Self {
            activity: Mutex::new(activity),
            question: Mutex::new(question),
            agent: Mutex::new(None),
        }
    }

    fn activity(&self) -> Vec<String> {
        lock(&self.activity).clone()
    }

    fn question(&self) -> Option<RunQuestion> {
        lock(&self.question).clone()
    }

    fn question_json(&self) -> Value {
        match self.question() {
            Some(question) => question.json(),
            None => Value::Null,
        }
    }

    fn close(&self) {
        *lock(&self.question) = None;
        if let Some(agent) = lock(&self.agent).take() {
            agent.close();
        }
    }
}

/// One preparation's conversation plus the bytes it may have to roll back.
struct SkillsOwner {
    owner: Owner,
    snapshot: SkillsSnapshot,
    unmanaged_names: Vec<String>,
}

struct PendingSkills {
    snapshot: Option<SkillsSnapshot>,
    unmanaged_names: Vec<String>,
}

#[derive(Clone)]
struct RunQuestion {
    id: Value,
    message: String,
    options: Vec<Value>,
}

impl RunQuestion {
    fn json(&self) -> Value {
        let mut object = Map::new();
        object.insert("id".into(), self.id.clone());
        object.insert("message".into(), Value::String(self.message.clone()));
        object.insert("options".into(), Value::Array(self.options.clone()));
        Value::Object(object)
    }

    fn frame(&self) -> Value {
        let mut object = Map::new();
        object.insert("type".into(), Value::String("question".into()));
        object.insert("id".into(), self.id.clone());
        object.insert("message".into(), Value::String(self.message.clone()));
        object.insert("options".into(), Value::Array(self.options.clone()));
        Value::Object(object)
    }
}

#[derive(Clone, Copy)]
enum Field {
    Creation,
    Revision,
    Preparation,
    Pending,
}

struct Section {
    owner: Arc<GoalAuthoring>,
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

static REGISTRY: LazyLock<Mutex<HashMap<PathBuf, Weak<GoalAuthoring>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn registry() -> &'static Mutex<HashMap<PathBuf, Weak<GoalAuthoring>>> {
    &REGISTRY
}

fn state_for(app: &Arc<App>) -> Option<Arc<GoalAuthoring>> {
    lock(registry())
        .get(app.shared.state_path())
        .and_then(Weak::upgrade)
}

impl GoalAuthoring {
    fn snapshot_field(&self, field: Field) -> Value {
        let inner = lock(&self.inner);
        match field {
            Field::Creation => match &inner.creation {
                None => Value::Null,
                Some(owner) => {
                    let mut object = Map::new();
                    object.insert("activity".into(), json!(owner.activity()));
                    object.insert("question".into(), owner.question_json());
                    Value::Object(object)
                }
            },
            Field::Revision => match &inner.revision {
                None => Value::Null,
                Some(owner) => {
                    let mut object = Map::new();
                    object.insert("activity".into(), json!(owner.activity()));
                    object.insert("question".into(), owner.question_json());
                    object.insert(
                        "request".into(),
                        inner
                            .revision_request
                            .clone()
                            .map(Value::String)
                            .unwrap_or(Value::Null),
                    );
                    Value::Object(object)
                }
            },
            Field::Preparation => match &inner.preparation {
                None => Value::Null,
                Some(preparation) => {
                    let mut object = Map::new();
                    object.insert("activity".into(), json!(preparation.owner.activity()));
                    object.insert("question".into(), preparation.owner.question_json());
                    object.insert("snapshot".into(), capture_snapshot(&preparation.snapshot));
                    object.insert("unmanagedNames".into(), json!(preparation.unmanaged_names));
                    Value::Object(object)
                }
            },
            Field::Pending => {
                if !inner.preparation_pending {
                    return Value::Null;
                }
                let Some(pending) = &inner.pending_skills else {
                    return Value::Null;
                };
                let mut object = Map::new();
                object.insert("activity".into(), json!(Vec::<String>::new()));
                object.insert("question".into(), Value::Null);
                object.insert(
                    "snapshot".into(),
                    match &pending.snapshot {
                        Some(snapshot) => capture_snapshot(snapshot),
                        None => Value::Null,
                    },
                );
                object.insert("unmanagedNames".into(), json!(pending.unmanaged_names));
                Value::Object(object)
            }
        }
    }

    fn restore_field(&self, field: Field, value: &Value) {
        let record = value.as_object();
        let mut inner = lock(&self.inner);
        match field {
            Field::Creation => {
                let Some(record) = record else {
                    return;
                };
                let Some(activity) = parse_activity(record.get("activity")) else {
                    return;
                };
                let question = parse_question(record.get("question"));
                inner.creation = Some(Arc::new(Owner::restored(activity, question)));
            }
            Field::Revision => {
                let Some(record) = record else {
                    return;
                };
                let Some(activity) = parse_activity(record.get("activity")) else {
                    return;
                };
                let question = parse_question(record.get("question"));
                inner.revision = Some(Arc::new(Owner::restored(activity, question)));
                inner.revision_request = record
                    .get("request")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            Field::Preparation => {
                let Some(record) = record else {
                    return;
                };
                let Some(activity) = parse_activity(record.get("activity")) else {
                    return;
                };
                let question = parse_question(record.get("question"));
                let snapshot = record
                    .get("snapshot")
                    .and_then(parse_snapshot)
                    .unwrap_or_default();
                let unmanaged_names = parse_names(record.get("unmanagedNames")).unwrap_or_default();
                inner.preparation = Some(Arc::new(SkillsOwner {
                    owner: Owner::restored(activity, question),
                    snapshot,
                    unmanaged_names,
                }));
            }
            Field::Pending => {
                let Some(record) = record else {
                    return;
                };
                let Some(_activity) = parse_activity(record.get("activity")) else {
                    return;
                };
                inner.preparation_pending = true;
                inner.pending_skills = Some(PendingSkills {
                    snapshot: record.get("snapshot").and_then(parse_snapshot),
                    unmanaged_names: parse_names(record.get("unmanagedNames")).unwrap_or_default(),
                });
            }
        }
    }

    /// Resumes the work a previous process left behind, after every section
    /// has restored. A task is scheduled only when one can run.
    fn schedule_resume(self: &Arc<Self>) {
        if self.resume_scheduled.swap(true, AtomicOrdering::SeqCst) {
            return;
        }
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let this = Arc::clone(self);
        handle.spawn(async move {
            // Every section restores synchronously during `App::new`; a short
            // pause keeps this resume behind all four of them.
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let Some(app) = this.app.get().and_then(Weak::upgrade) else {
                return;
            };
            this.resume_restored(&app).await;
        });
    }

    async fn resume_restored(self: &Arc<Self>, app: &Arc<App>) {
        let pending = {
            let mut inner = lock(&self.inner);
            if inner.preparation_pending {
                let pending = inner.pending_skills.take();
                inner.preparation_pending = false;
                Some(pending)
            } else {
                None
            }
        };
        let target = Target::Broadcast(Arc::clone(app));
        if let Some(pending) = pending {
            let restored = pending.and_then(|pending| {
                pending.snapshot.map(|snapshot| RestoredPreparation {
                    snapshot,
                    unmanaged_names: pending.unmanaged_names,
                })
            });
            self.start_preparation(app, &target, restored).await;
            return;
        }
        let (creation, revision, preparation) = {
            let inner = lock(&self.inner);
            (
                inner.creation.clone(),
                inner.revision.clone(),
                inner.preparation.clone(),
            )
        };
        if let Some(owner) = creation {
            Arc::clone(self)
                .spawn_creation(Arc::clone(app), owner)
                .await;
            return;
        }
        if let Some(owner) = revision {
            Arc::clone(self)
                .spawn_revision(Arc::clone(app), owner)
                .await;
            return;
        }
        if let Some(preparation) = preparation {
            Arc::clone(self)
                .spawn_preparation(Arc::clone(app), preparation)
                .await;
        }
    }

    fn clear_creation(&self, owner: &Arc<Owner>) -> bool {
        let mut inner = lock(&self.inner);
        match &inner.creation {
            Some(current) if Arc::ptr_eq(current, owner) => {
                inner.creation = None;
                true
            }
            _ => false,
        }
    }

    fn clear_revision(&self, owner: &Arc<Owner>) -> bool {
        let mut inner = lock(&self.inner);
        match &inner.revision {
            Some(current) if Arc::ptr_eq(current, owner) => {
                inner.revision = None;
                true
            }
            _ => false,
        }
    }

    fn clear_preparation(&self, preparation: &Arc<SkillsOwner>) -> bool {
        let mut inner = lock(&self.inner);
        match &inner.preparation {
            Some(current) if Arc::ptr_eq(current, preparation) => {
                inner.preparation = None;
                true
            }
            _ => false,
        }
    }

    fn is_current_creation(&self, owner: &Arc<Owner>) -> bool {
        let inner = lock(&self.inner);
        inner
            .creation
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, owner))
    }

    fn is_current_revision(&self, owner: &Arc<Owner>) -> bool {
        let inner = lock(&self.inner);
        inner
            .revision
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, owner))
    }

    fn is_current_preparation(&self, preparation: &Arc<SkillsOwner>) -> bool {
        let inner = lock(&self.inner);
        inner
            .preparation
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, preparation))
    }

    fn preparation_cancelled(&self, request: u64) -> bool {
        lock(&self.inner).preparation_request != request
    }

    /// Ends every goal-authoring run a reset or a creation preempts, restoring
    /// the skills bytes a half-finished preparation still owes.
    fn abort_everything(&self, app: &Arc<App>) {
        lock(&self.inner).creation_request += 1;
        self.abort_creation(app);
        self.abort_revision(app);
        lock(&self.inner).preparation_request += 1;
        let pending = {
            let mut inner = lock(&self.inner);
            inner.preparation_pending = false;
            inner.pending_skills.take()
        };
        if let Some(pending) = pending {
            if let Some(snapshot) = pending.snapshot {
                let _ = restore_directory_sync(&skills_directory(app), &snapshot);
            }
        }
        let preparation = lock(&self.inner).preparation.take();
        if let Some(preparation) = preparation {
            preparation.owner.close();
            if let Err(error) =
                restore_directory_sync(&skills_directory(app), &preparation.snapshot)
            {
                app.shared.broadcast(error_event(format!(
                    "Could not restore the previous skills: {error}"
                )));
            }
            app.shared
                .broadcast(json!({"type": "skillsPreparationStopped", "completed": false}));
        }
    }

    fn abort_creation(&self, app: &Arc<App>) {
        let owner = lock(&self.inner).creation.take();
        if let Some(owner) = owner {
            owner.close();
            app.shared
                .broadcast(json!({"type": "goalCreationStopped", "completed": false}));
        }
    }

    fn abort_revision(&self, app: &Arc<App>) {
        let owner = lock(&self.inner).revision.take();
        if let Some(owner) = owner {
            owner.close();
            app.shared
                .broadcast(json!({"type": "goalRevisionStopped", "completed": false}));
        }
    }
}

// ---------------------------------------------------------------------------
// Start paths
// ---------------------------------------------------------------------------

impl GoalAuthoring {
    async fn start_creation(self: &Arc<Self>, app: &Arc<App>, target: &Target) {
        if refuse_flow(app, target) || refuse_discover(app, target) {
            return;
        }
        {
            let inner = lock(&self.inner);
            if inner.preparation.is_some() || inner.preparation_pending {
                target.send(error_event("A skills preparation is active."));
                return;
            }
        }
        let request = {
            let mut inner = lock(&self.inner);
            inner.creation_request += 1;
            inner.creation_request
        };
        let path = creation_goal_path(app);
        if let Err(error) = tokio::fs::read_to_string(&path).await {
            if error.kind() != std::io::ErrorKind::NotFound {
                if lock(&self.inner).creation_request == request {
                    target.send(error_event(format!("Could not read the goal: {error}")));
                }
                return;
            }
        }
        if lock(&self.inner).creation_request != request {
            return;
        }

        // A creation always wins: it preempts the run, lifecycle, and earlier
        // goal-authoring work that would contend with the new peer.
        app.shared.abort_all_work();

        let owner = Arc::new(Owner::new());
        lock(&self.inner).creation = Some(Arc::clone(&owner));
        app.shared.broadcast(json!({"type": "goalCreationStarted"}));

        let this = Arc::clone(self);
        let app = Arc::clone(app);
        tokio::spawn(async move {
            this.spawn_creation(app, owner).await;
        });
    }

    async fn start_revision(
        self: &Arc<Self>,
        app: &Arc<App>,
        target: &Target,
        request: Option<&Value>,
    ) {
        if refuse_flow(app, target) || refuse_discover(app, target) {
            return;
        }
        {
            let inner = lock(&self.inner);
            if inner.preparation.is_some() || inner.preparation_pending {
                target.send(error_event("A skills preparation is active."));
                return;
            }
            if inner.creation.is_some() {
                target.send(error_event("A goal creation is active."));
                return;
            }
        }
        // A paused lifecycle keeps its lanes suspended; revision may start
        // beside it, but an active run or an unpaused lifecycle refuses.
        if let Some(reason) = goal_run_refusal(app, true) {
            target.send(error_event(reason));
            return;
        }
        if lock(&self.inner).revision.is_some() {
            target.send(error_event("A goal revision is already active."));
            return;
        }
        let request = match request {
            None => None,
            Some(Value::String(text)) => Some(text.clone()),
            Some(_) => {
                target.send(error_event("reviseGoal needs the guidance text."));
                return;
            }
        };

        let owner = Arc::new(Owner::new());
        {
            let mut inner = lock(&self.inner);
            inner.revision_request = request;
            inner.revision = Some(Arc::clone(&owner));
        }
        app.shared.broadcast(json!({"type": "goalRevisionStarted"}));

        let this = Arc::clone(self);
        let app = Arc::clone(app);
        tokio::spawn(async move {
            this.spawn_revision(app, owner).await;
        });
    }

    async fn start_preparation(
        self: &Arc<Self>,
        app: &Arc<App>,
        target: &Target,
        restored: Option<RestoredPreparation>,
    ) {
        if refuse_flow(app, target) || refuse_discover(app, target) {
            return;
        }
        {
            let inner = lock(&self.inner);
            if inner.preparation.is_some() || inner.preparation_pending {
                target.send(error_event("A skills preparation is already active."));
                return;
            }
            if inner.creation.is_some() {
                target.send(error_event("A goal creation is active."));
                return;
            }
            if inner.revision.is_some() {
                target.send(error_event("A goal revision is active."));
                return;
            }
        }
        if let Some(reason) = goal_run_refusal(app, false) {
            target.send(error_event(reason));
            return;
        }

        let request = {
            let mut inner = lock(&self.inner);
            inner.preparation_request += 1;
            inner.preparation_pending = true;
            inner.preparation_request
        };
        let cancelled = || self.preparation_cancelled(request);

        let goal_text = match tokio::fs::read_to_string(&app.config().goal_file).await {
            Ok(text) => text,
            Err(error) => {
                if cancelled() {
                    return;
                }
                lock(&self.inner).preparation_pending = false;
                if error.kind() == std::io::ErrorKind::NotFound {
                    target.send(error_event(
                        "The goal is not set. Save a non-empty goal before preparing skills.",
                    ));
                } else {
                    target.send(error_event(format!("Could not read the goal: {error}")));
                    target.send(json!({"type": "skillsPreparationStopped", "completed": false}));
                }
                return;
            }
        };
        if cancelled() {
            return;
        }
        if goal_text.trim().is_empty() {
            lock(&self.inner).preparation_pending = false;
            target.send(error_event(
                "The goal is not set. Save a non-empty goal before preparing skills.",
            ));
            return;
        }

        let skills_dir = skills_directory(app);
        let prepared = match &restored {
            None => {
                async {
                    let snapshot = snapshot_directory(&skills_dir)
                        .await
                        .map_err(|error| error.to_string())?;
                    let installed = inspect_skills(&skills_dir).await?;
                    let mut names: Vec<String> = Vec::new();
                    for name in installed
                        .unmanaged
                        .iter()
                        .map(|skill| skill.directory.clone())
                        .chain(
                            installed
                                .discover
                                .iter()
                                .map(|skill| skill.directory.clone()),
                        )
                    {
                        if !names.contains(&name) {
                            names.push(name);
                        }
                    }
                    Ok::<_, String>((snapshot, names))
                }
                .await
            }
            Some(restored) => {
                let mut outcome = Ok((restored.snapshot.clone(), restored.unmanaged_names.clone()));
                if let Err(error) = restore_directory(&skills_dir, &restored.snapshot).await {
                    outcome = Err(error.to_string());
                }
                outcome
            }
        };
        let (snapshot, unmanaged_names) = match prepared {
            Ok(prepared) => prepared,
            Err(message) => {
                if cancelled() {
                    return;
                }
                {
                    let mut inner = lock(&self.inner);
                    inner.preparation_pending = false;
                    inner.pending_skills = None;
                }
                target.send(error_event(format!(
                    "Could not read the installed skills: {message}"
                )));
                return;
            }
        };
        if cancelled() {
            return;
        }
        let managed_names = match managed_skill_names(&skills_dir, &snapshot).await {
            Ok(names) => names,
            Err(message) => {
                if cancelled() {
                    return;
                }
                {
                    let mut inner = lock(&self.inner);
                    inner.preparation_pending = false;
                    inner.pending_skills = None;
                }
                target.send(error_event(format!(
                    "Could not read the installed skills: {message}"
                )));
                return;
            }
        };
        if cancelled() {
            return;
        }

        // Record the rollback bytes before anything is deleted.
        lock(&self.inner).pending_skills = Some(PendingSkills {
            snapshot: Some(snapshot.clone()),
            unmanaged_names: unmanaged_names.clone(),
        });
        persist_now(app);

        for name in &managed_names {
            if let Err(error) = remove_path(&skills_dir.join(name)).await {
                if cancelled() {
                    let _ = restore_directory(&skills_dir, &snapshot).await;
                    return;
                }
                {
                    let mut inner = lock(&self.inner);
                    inner.preparation_pending = false;
                    inner.pending_skills = None;
                }
                let _ = restore_directory(&skills_dir, &snapshot).await;
                target.send(error_event(format!(
                    "Could not replace the managed skills: {error}"
                )));
                return;
            }
            if cancelled() {
                let _ = restore_directory(&skills_dir, &snapshot).await;
                return;
            }
        }
        if cancelled() {
            let _ = restore_directory(&skills_dir, &snapshot).await;
            return;
        }

        let preparation = Arc::new(SkillsOwner {
            owner: Owner::new(),
            snapshot,
            unmanaged_names,
        });
        {
            let mut inner = lock(&self.inner);
            inner.preparation_pending = false;
            inner.pending_skills = None;
            inner.preparation = Some(Arc::clone(&preparation));
        }
        app.shared
            .broadcast(json!({"type": "skillsPreparationStarted"}));

        let this = Arc::clone(self);
        let app = Arc::clone(app);
        tokio::spawn(async move {
            this.spawn_preparation(app, preparation).await;
        });
    }
}

struct RestoredPreparation {
    snapshot: SkillsSnapshot,
    unmanaged_names: Vec<String>,
}

// ---------------------------------------------------------------------------
// Peer runs
// ---------------------------------------------------------------------------

#[derive(Clone)]
enum OwnerRef {
    Creation(Arc<Owner>),
    Revision(Arc<Owner>),
    Preparation(Arc<SkillsOwner>),
}

impl OwnerRef {
    fn owner(&self) -> &Owner {
        match self {
            Self::Creation(owner) | Self::Revision(owner) => owner,
            Self::Preparation(preparation) => &preparation.owner,
        }
    }

    fn is_current(&self, this: &GoalAuthoring) -> bool {
        match self {
            Self::Creation(owner) => this.is_current_creation(owner),
            Self::Revision(owner) => this.is_current_revision(owner),
            Self::Preparation(preparation) => this.is_current_preparation(preparation),
        }
    }
}

impl GoalAuthoring {
    async fn spawn_creation(self: Arc<Self>, app: Arc<App>, owner: Arc<Owner>) {
        let before = match read_goal_snapshot(&creation_goal_path(&app)).await {
            Ok(before) => before,
            Err(error) => {
                if self.is_current_creation(&owner) {
                    app.shared
                        .broadcast(error_event(format!("Could not read the goal: {error}")));
                    self.stop_creation(&app, &owner, false, None).await;
                }
                return;
            }
        };
        let environment = match app.providers.select_environment().await {
            Ok(environment) => environment,
            Err(error) => {
                if self.is_current_creation(&owner) {
                    app.shared.broadcast(error_event(error.message));
                    self.stop_creation(&app, &owner, false, before).await;
                }
                return;
            }
        };
        if !self.is_current_creation(&owner) {
            return;
        }
        let (connection, events) = match connect_peer(&app, environment).await {
            Ok(peer) => peer,
            Err(message) => {
                if self.is_current_creation(&owner) {
                    app.shared.broadcast(error_event(message));
                    self.stop_creation(&app, &owner, false, before).await;
                }
                return;
            }
        };
        if !self.is_current_creation(&owner) {
            connection.close();
            return;
        }
        *lock(&owner.agent) = Some(Arc::clone(&connection));
        let which = OwnerRef::Creation(Arc::clone(&owner));
        let outcome = drive(
            &app,
            &self,
            &which,
            events,
            &connection,
            GOAL_CREATION_PROMPT,
            "goal-creation",
        )
        .await;
        if !self.is_current_creation(&owner) {
            return;
        }
        match outcome {
            Ok(()) => {
                self.stop_creation(&app, &owner, true, before).await;
            }
            Err(message) => {
                app.shared.broadcast(error_event(message));
                self.stop_creation(&app, &owner, false, before).await;
            }
        }
    }

    async fn stop_creation(
        &self,
        app: &Arc<App>,
        owner: &Arc<Owner>,
        succeeded: bool,
        before: Option<String>,
    ) {
        if !self.clear_creation(owner) {
            return;
        }
        owner.close();
        if !succeeded {
            app.shared
                .broadcast(json!({"type": "goalCreationStopped", "completed": false}));
            return;
        }
        let text = match tokio::fs::read_to_string(creation_goal_path(app)).await {
            Ok(text) => text,
            Err(error) => {
                app.shared.broadcast(error_event(format!(
                    "Could not read the created goal: {error}"
                )));
                app.shared
                    .broadcast(json!({"type": "goalCreationStopped", "completed": false}));
                return;
            }
        };
        if text.trim().is_empty() {
            app.shared.broadcast(error_event(
                "The goal creation ended without a non-empty goal.",
            ));
            app.shared
                .broadcast(json!({"type": "goalCreationStopped", "completed": false}));
            return;
        }
        if before.as_deref() == Some(text.as_str()) {
            app.shared.broadcast(error_event(
                "The goal creation ended without writing a new goal.",
            ));
            app.shared
                .broadcast(json!({"type": "goalCreationStopped", "completed": false}));
            return;
        }
        app.shared.broadcast(json!({
            "type": "goalCreationStopped",
            "completed": true,
            "text": text,
        }));
    }

    async fn spawn_revision(self: Arc<Self>, app: Arc<App>, owner: Arc<Owner>) {
        let before = match read_goal_snapshot(&app.config().goal_file).await {
            Ok(before) => before,
            Err(error) => {
                if self.is_current_revision(&owner) {
                    app.shared
                        .broadcast(error_event(format!("Could not read the goal: {error}")));
                    self.stop_revision(&app, &owner, false, None).await;
                }
                return;
            }
        };
        let environment = match app.providers.select_environment().await {
            Ok(environment) => environment,
            Err(error) => {
                if self.is_current_revision(&owner) {
                    app.shared.broadcast(error_event(error.message));
                    self.stop_revision(&app, &owner, false, before).await;
                }
                return;
            }
        };
        if !self.is_current_revision(&owner) {
            return;
        }
        let (connection, events) = match connect_peer(&app, environment).await {
            Ok(peer) => peer,
            Err(message) => {
                if self.is_current_revision(&owner) {
                    app.shared.broadcast(error_event(message));
                    self.stop_revision(&app, &owner, false, before).await;
                }
                return;
            }
        };
        if !self.is_current_revision(&owner) {
            connection.close();
            return;
        }
        *lock(&owner.agent) = Some(Arc::clone(&connection));
        let request = lock(&self.inner).revision_request.clone();
        let prompt = revision_prompt(&app.config().goal_file, request.as_deref());
        let which = OwnerRef::Revision(Arc::clone(&owner));
        let outcome = drive(
            &app,
            &self,
            &which,
            events,
            &connection,
            &prompt,
            "goal-revision",
        )
        .await;
        if !self.is_current_revision(&owner) {
            return;
        }
        match outcome {
            Ok(()) => {
                self.stop_revision(&app, &owner, true, before).await;
            }
            Err(message) => {
                app.shared.broadcast(error_event(message));
                self.stop_revision(&app, &owner, false, before).await;
            }
        }
    }

    async fn stop_revision(
        &self,
        app: &Arc<App>,
        owner: &Arc<Owner>,
        succeeded: bool,
        before: Option<String>,
    ) {
        if !self.clear_revision(owner) {
            return;
        }
        owner.close();
        if !succeeded {
            app.shared
                .broadcast(json!({"type": "goalRevisionStopped", "completed": false}));
            return;
        }
        let text = match tokio::fs::read_to_string(&app.config().goal_file).await {
            Ok(text) => text,
            Err(error) => {
                app.shared.broadcast(error_event(format!(
                    "Could not read the revised goal: {error}"
                )));
                app.shared
                    .broadcast(json!({"type": "goalRevisionStopped", "completed": false}));
                return;
            }
        };
        if before.as_deref() == Some(text.as_str()) {
            app.shared.broadcast(error_event(
                "The goal revision ended without changing the goal.",
            ));
            app.shared
                .broadcast(json!({"type": "goalRevisionStopped", "completed": false}));
            return;
        }
        app.shared.broadcast(json!({
            "type": "goalRevisionStopped",
            "completed": true,
            "text": text,
        }));
    }

    async fn spawn_preparation(self: Arc<Self>, app: Arc<App>, preparation: Arc<SkillsOwner>) {
        let environment = match app.providers.select_environment().await {
            Ok(environment) => environment,
            Err(error) => {
                if self.is_current_preparation(&preparation) {
                    app.shared.broadcast(error_event(error.message));
                    self.stop_preparation(&app, &preparation, false).await;
                }
                return;
            }
        };
        if !self.is_current_preparation(&preparation) {
            return;
        }
        let (connection, events) = match connect_peer(&app, environment).await {
            Ok(peer) => peer,
            Err(message) => {
                if self.is_current_preparation(&preparation) {
                    app.shared.broadcast(error_event(message));
                    self.stop_preparation(&app, &preparation, false).await;
                }
                return;
            }
        };
        if !self.is_current_preparation(&preparation) {
            connection.close();
            return;
        }
        *lock(&preparation.owner.agent) = Some(Arc::clone(&connection));
        let which = OwnerRef::Preparation(Arc::clone(&preparation));
        let outcome = drive(
            &app,
            &self,
            &which,
            events,
            &connection,
            SKILLS_PROMPT,
            "skills",
        )
        .await;
        if !self.is_current_preparation(&preparation) {
            return;
        }
        match outcome {
            Ok(()) => {
                self.finish_preparation(&app, &preparation).await;
            }
            Err(message) => {
                app.shared.broadcast(error_event(message));
                self.stop_preparation(&app, &preparation, false).await;
            }
        }
    }

    /// Ends one preparation. A failure restores the pre-run skills directory
    /// byte for byte, so managed skills keep their previous contents and no
    /// generated skill survives.
    async fn stop_preparation(
        &self,
        app: &Arc<App>,
        preparation: &Arc<SkillsOwner>,
        succeeded: bool,
    ) {
        if !self.clear_preparation(preparation) {
            return;
        }
        preparation.owner.close();
        if succeeded {
            return;
        }
        if let Err(error) = restore_directory(&skills_directory(app), &preparation.snapshot).await {
            app.shared.broadcast(error_event(format!(
                "Could not restore the previous skills: {error}"
            )));
        }
        app.shared
            .broadcast(json!({"type": "skillsPreparationStopped", "completed": false}));
    }

    async fn finish_preparation(&self, app: &Arc<App>, preparation: &Arc<SkillsOwner>) {
        if !self.is_current_preparation(preparation) {
            return;
        }
        let skills_dir = skills_directory(app);
        let read = match (
            snapshot_directory(&skills_dir).await,
            inspect_skills(&skills_dir).await,
        ) {
            (Ok(current), Ok(inspection)) => Ok((current, inspection)),
            (Err(error), _) => Err(error.to_string()),
            (_, Err(message)) => Err(message),
        };
        let (current, inspection) = match read {
            Ok(read) => read,
            Err(error) => {
                if !self.is_current_preparation(preparation) {
                    return;
                }
                app.shared.broadcast(error_event(format!(
                    "Could not read the prepared skills: {error}"
                )));
                self.stop_preparation(app, preparation, false).await;
                return;
            }
        };
        if !self.is_current_preparation(preparation) {
            return;
        }

        let mut errors = inspection.errors.clone();
        if inspection.prepare.is_empty() {
            errors.push("no managed skill was prepared.".to_string());
        }

        let mut changed: BTreeSet<String> = BTreeSet::new();
        let unmanaged_directory = |relative: &str| -> Option<String> {
            let directory = relative.split('/').next()?;
            if preparation
                .unmanaged_names
                .iter()
                .any(|name| name == directory)
            {
                Some(directory.to_string())
            } else {
                None
            }
        };
        let mut paths: HashSet<&String> = HashSet::new();
        paths.extend(
            preparation
                .snapshot
                .files
                .iter()
                .map(|(relative, _)| relative),
        );
        paths.extend(current.files.iter().map(|(relative, _)| relative));
        for relative in paths {
            let Some(directory) = unmanaged_directory(relative) else {
                continue;
            };
            let before = preparation
                .snapshot
                .files
                .iter()
                .find(|(path, _)| path == relative)
                .map(|(_, bytes)| bytes);
            let after = current
                .files
                .iter()
                .find(|(path, _)| path == relative)
                .map(|(_, bytes)| bytes);
            if before.is_none() || after.is_none() || before != after {
                changed.insert(directory);
            }
        }
        let mut links: HashSet<&String> = HashSet::new();
        links.extend(
            preparation
                .snapshot
                .symlinks
                .iter()
                .map(|(relative, _)| relative),
        );
        links.extend(current.symlinks.iter().map(|(relative, _)| relative));
        for relative in links {
            let Some(directory) = unmanaged_directory(relative) else {
                continue;
            };
            let before = preparation
                .snapshot
                .symlinks
                .iter()
                .find(|(path, _)| path == relative)
                .map(|(_, target)| target);
            let after = current
                .symlinks
                .iter()
                .find(|(path, _)| path == relative)
                .map(|(_, target)| target);
            if before != after {
                changed.insert(directory);
            }
        }
        let before_directories = snapshot_skill_directories(&preparation.snapshot);
        for name in snapshot_skill_directories(&current) {
            if before_directories.contains(&name)
                || inspection
                    .prepare
                    .iter()
                    .any(|skill| skill.directory == name)
            {
                continue;
            }
            changed.insert(name);
        }
        for name in &changed {
            errors.push(format!(
                "unmanaged skill \"{name}\" must not be changed by skills preparation."
            ));
        }
        let mut prepare_names: Vec<String> = inspection
            .prepare
            .iter()
            .map(|skill| skill.directory.clone())
            .collect();
        prepare_names.sort();
        for name in prepare_names {
            if preparation
                .unmanaged_names
                .iter()
                .any(|known| known == &name)
            {
                errors.push(format!(
                    "managed skill \"{name}\" collides with a skill of another family or owner."
                ));
            }
        }

        if !errors.is_empty() {
            app.shared.broadcast(error_event(format!(
                "Skills preparation failed: {}",
                errors.join(" ")
            )));
            self.stop_preparation(app, preparation, false).await;
            return;
        }
        if !inspection.contradictions.is_empty() {
            app.shared.broadcast(error_event(format!(
                "Skills preparation failed: {}",
                describe_contradictions(&inspection.contradictions, &inspection.managed)
            )));
            self.stop_preparation(app, preparation, false).await;
            return;
        }

        if !self.clear_preparation(preparation) {
            return;
        }
        preparation.owner.close();
        app.shared.broadcast(json!({
            "type": "skillsPreparationStopped",
            "completed": true,
            "skills": inspection.summaries(),
            "contradictions": [],
        }));
    }
}

/// One peer started with the same command, cwd, environment, and permission
/// policy every Devboard peer uses.
async fn connect_peer(
    app: &Arc<App>,
    environment: HashMap<String, Option<String>>,
) -> Result<(Arc<AcpConnection>, mpsc::UnboundedReceiver<AcpEvent>), String> {
    let env: HashMap<String, String> = environment
        .into_iter()
        .filter_map(|(key, value)| value.map(|value| (key, value)))
        .collect();
    let options = AcpConnectionOptions::new(
        app.config().agent_command.clone(),
        app.config().repo_dir.to_string_lossy().into_owned(),
    )
    .with_starter("Goal authoring")
    .with_env(env)
    .with_permission_policy(PermissionPolicy::Allow);
    let (connection, events) = AcpConnection::connect(options)
        .await
        .map_err(|error| error.message)?;
    Ok((Arc::new(connection), events))
}

/// Runs one peer turn while relaying every event its owner may see. Events
/// still queued when the turn resolves are delivered before the caller stops
/// the run, so the outcome never precedes the activity that produced it.
async fn drive(
    app: &Arc<App>,
    this: &Arc<GoalAuthoring>,
    which: &OwnerRef,
    mut events: mpsc::UnboundedReceiver<AcpEvent>,
    connection: &Arc<AcpConnection>,
    prompt: &str,
    scope: &str,
) -> Result<(), String> {
    let run = connection.run(prompt);
    tokio::pin!(run);
    let outcome = loop {
        tokio::select! {
            event = events.recv() => {
                match event {
                    Some(event) => apply_event(app, this, which, event, scope),
                    None => break run.await,
                }
            }
            result = &mut run => break result,
        }
    };
    while let Ok(event) = events.try_recv() {
        apply_event(app, this, which, event, scope);
    }
    match outcome {
        Ok(_) => Ok(()),
        Err(error) => Err(error.message),
    }
}

fn apply_event(
    app: &Arc<App>,
    this: &Arc<GoalAuthoring>,
    which: &OwnerRef,
    event: AcpEvent,
    scope: &str,
) {
    match event {
        AcpEvent::Activity(activity) => {
            app.shared.journal.write("activity", &activity.text, None);
            if !which.is_current(this) {
                return;
            }
            record_activity(app, which.owner(), &activity);
        }
        AcpEvent::Question(question) => {
            app.shared
                .journal
                .write("question", &question.message, Some(scope));
            if !which.is_current(this) {
                return;
            }
            let stored = RunQuestion {
                id: acp_id_value(&question.id),
                message: question.message,
                options: question_options(&question.options),
            };
            *lock(&which.owner().question) = Some(stored.clone());
            app.shared.broadcast(stored.frame());
        }
        AcpEvent::Stderr(text) => {
            app.shared.journal.write("acp-stderr", &text, None);
            eprint!("{text}");
        }
        AcpEvent::SessionUpdate | AcpEvent::Text(_) => {}
    }
}

fn record_activity(app: &Arc<App>, owner: &Owner, activity: &AcpActivity) {
    let appended = {
        let mut store = lock(&owner.activity);
        let append = activity.append && !store.is_empty();
        if append {
            if let Some(last) = store.last_mut() {
                last.push_str(&activity.text);
            }
        } else {
            store.push(activity.text.clone());
        }
        trim_activity(&mut store);
        append
    };
    let event = if appended {
        json!({"type": "activity", "text": activity.text, "append": true})
    } else {
        json!({"type": "activity", "text": activity.text})
    };
    app.shared.broadcast(event);
}

fn acp_id_value(id: &AcpId) -> Value {
    match id {
        AcpId::Number(number) => json!(number),
        AcpId::String(text) => Value::String(text.clone()),
    }
}

fn question_options(options: &[AcpQuestionOption]) -> Vec<Value> {
    serde_json::to_value(options)
        .ok()
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Answering a question
// ---------------------------------------------------------------------------

impl GoalAuthoring {
    fn answer_question(
        self: &Arc<Self>,
        conn: &Conn,
        id: Option<&Value>,
        value: Option<&Value>,
        lane: Option<&Value>,
    ) -> bool {
        let active: Option<OwnerRef> = {
            let inner = lock(&self.inner);
            if let Some(owner) = &inner.creation {
                Some(OwnerRef::Creation(Arc::clone(owner)))
            } else if let Some(owner) = &inner.revision {
                Some(OwnerRef::Revision(Arc::clone(owner)))
            } else {
                inner
                    .preparation
                    .as_ref()
                    .map(|preparation| OwnerRef::Preparation(Arc::clone(preparation)))
            }
        };
        let Some(active) = active else {
            return false;
        };

        let id = match id {
            Some(Value::String(text)) => Some(text.clone()),
            Some(Value::Number(number)) => Some(number.to_string()),
            _ => None,
        };
        let value = value.and_then(Value::as_str);
        let (Some(id), Some(value)) = (id, value) else {
            conn.send(error_event(
                "An answer needs the question id and a non-empty value.",
            ));
            return true;
        };
        if value.trim().is_empty() {
            conn.send(error_event(
                "An answer needs the question id and a non-empty value.",
            ));
            return true;
        }

        let question = match active.owner().question() {
            Some(question) => question,
            None => {
                if lane.and_then(Value::as_str).is_some() {
                    return false;
                }
                conn.send(error_event("No pending question with that id."));
                return true;
            }
        };
        if question_id_key(&question.id) != id {
            if lane.and_then(Value::as_str).is_some() {
                // A lane belongs to another mode; let it answer.
                return false;
            }
            conn.send(error_event("No pending question with that id."));
            return true;
        }

        let conn = conn.clone();
        let value = value.to_string();
        let question_id = question.id.clone();
        let app = self.app.get().and_then(Weak::upgrade);
        tokio::spawn(async move {
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(5_000);
            loop {
                if !question_matches(&active, &id) {
                    return;
                }
                if let Some(agent) = anchor_connection(&active) {
                    let Some(acp_id) = acp_id_from_value(&question_id) else {
                        conn.send(error_event("The question is no longer pending."));
                        return;
                    };
                    if agent.answer(&acp_id, &value).await {
                        let owner = active.owner();
                        let cleared = {
                            let mut question = lock(&owner.question);
                            let cleared = question
                                .as_ref()
                                .is_some_and(|current| question_id_key(&current.id) == id);
                            if cleared {
                                *question = None;
                            }
                            cleared
                        };
                        // The page keeps the prompt and the draft until a
                        // frame proves the answer was accepted.
                        if cleared {
                            if let Some(app) = &app {
                                app.shared
                                    .broadcast(question_cleared_event(&question_id, None));
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
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        });
        true
    }
}

fn anchor_connection(owner: &OwnerRef) -> Option<Arc<AcpConnection>> {
    lock(&owner.owner().agent).clone()
}

fn question_matches(owner: &OwnerRef, id: &str) -> bool {
    owner
        .owner()
        .question()
        .is_some_and(|question| question_id_key(&question.id) == id)
}

fn question_id_key(id: &Value) -> String {
    match id {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        other => other.to_string(),
    }
}

fn acp_id_from_value(value: &Value) -> Option<AcpId> {
    match value {
        Value::String(text) => Some(AcpId::String(text.clone())),
        Value::Number(number) => number.as_i64().map(AcpId::Number),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Skills state and deletion
// ---------------------------------------------------------------------------

async fn send_skills_state(app: &Arc<App>, target: &Target) {
    match inspect_skills(&skills_directory(app)).await {
        Ok(inspection) => {
            let mut object = Map::new();
            object.insert("type".into(), Value::String("skillsState".into()));
            object.insert("skills".into(), Value::Array(inspection.summaries()));
            object.insert(
                "contradictions".into(),
                Value::Array(
                    inspection
                        .contradictions
                        .iter()
                        .map(Contradiction::json)
                        .collect(),
                ),
            );
            target.send(Value::Object(object));
        }
        Err(message) => {
            target.send(error_event(format!(
                "Could not read the installed skills: {message}"
            )));
        }
    }
}

async fn send_installed_skills(app: &Arc<App>, target: &Target) {
    target.send(crate::installed_skills::installed_skills_payload(&app.config().repo_dir).await);
}

async fn delete_skill(app: &Arc<App>, target: &Target, name: Option<&Value>) {
    let Some(name) = name.and_then(Value::as_str) else {
        target.send(error_event("Choose a prepared skill to delete."));
        send_installed_skills(app, target).await;
        return;
    };
    if !crate::installed_skills::is_skill_name(name) {
        target.send(error_event("Choose a prepared skill to delete."));
        send_installed_skills(app, target).await;
        return;
    }
    if let Some(this) = state_for(app) {
        let label = {
            let inner = lock(&this.inner);
            if inner.creation.is_some() {
                Some("a goal creation")
            } else if inner.revision.is_some() {
                Some("a goal revision")
            } else if inner.preparation.is_some() || inner.preparation_pending {
                Some("skills preparation")
            } else {
                None
            }
        };
        if let Some(label) = label {
            target.send(error_event(format!(
                "Cannot delete a skill while {label} is active."
            )));
            send_installed_skills(app, target).await;
            return;
        }
        if app.shared.gate_active("goal-run") {
            let label = goal_label(app.shared.gate_reason("goal-run"));
            target.send(error_event(format!(
                "Cannot delete a skill while {label} is active."
            )));
            send_installed_skills(app, target).await;
            return;
        }
    }
    if app.shared.gate_active("flow") {
        target.send(error_event(
            "Cannot delete a skill while Flow Mode is active.",
        ));
        send_installed_skills(app, target).await;
        return;
    }

    let skills_dir = skills_directory(app);
    let inspection = match inspect_skills(&skills_dir).await {
        Ok(inspection) => inspection,
        Err(message) => {
            target.send(error_event(format!(
                "Could not read the installed skills: {message}"
            )));
            send_installed_skills(app, target).await;
            return;
        }
    };
    let managed = inspection
        .managed
        .iter()
        .find(|skill| skill.directory == name);
    let unmanaged = inspection
        .unmanaged
        .iter()
        .find(|skill| skill.directory == name);
    if managed.is_some_and(|skill| skill.builtin) || unmanaged.is_some_and(|skill| skill.builtin) {
        target.send(error_event(format!(
            "\"{name}\" is a built-in skill and cannot be deleted."
        )));
        send_installed_skills(app, target).await;
        return;
    }
    let removable = managed.is_some_and(|skill| skill.family == Family::Prepare);
    if !removable {
        target.send(error_event(format!(
            "No prepared skill named \"{name}\" is installed."
        )));
        send_installed_skills(app, target).await;
        return;
    }

    let settings_path = crate::installed_skills::project_settings_path(&app.config().repo_dir);
    // Read and validate the settings before the directory goes: an unreadable
    // settings file must leave both the skill and its setting.
    let settings =
        match crate::installed_skills::skill_exclusion_after_removal(&settings_path, name).await {
            Ok(settings) => settings,
            Err(message) => {
                target.send(error_event(format!(
                    "Could not read the project skill settings: {message}"
                )));
                send_installed_skills(app, target).await;
                return;
            }
        };

    if let Err(error) = remove_path(&skills_dir.join(name)).await {
        target.send(error_event(format!("Could not delete \"{name}\": {error}")));
        send_installed_skills(app, target).await;
        return;
    }

    let mut settings_error: Option<String> = None;
    if let Some(settings) = settings {
        let text = match serde_json::to_string_pretty(&settings) {
            Ok(text) => format!("{text}\n"),
            Err(error) => {
                settings_error = Some(error.to_string());
                String::new()
            }
        };
        if settings_error.is_none() {
            if let Err(error) = crate::state::write_file_atomically(&settings_path, &text).await {
                settings_error = Some(error.to_string());
            }
        }
    }
    // Both tables follow one deletion: Goal reads `skillsState`, the Devboard
    // Skills page reads `installedSkills`.
    send_skills_state(app, &Target::Broadcast(Arc::clone(app))).await;
    let installed = crate::installed_skills::installed_skills_payload(&app.config().repo_dir).await;
    app.shared.send_all(installed, None);
    if let Some(error) = settings_error {
        target.send(error_event(format!(
            "Deleted \"{name}\", but could not update the skill setting: {error}"
        )));
    }
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

#[derive(Clone)]
enum Target {
    Conn(Conn),
    Broadcast(Arc<App>),
}

impl Target {
    fn send(&self, event: Value) {
        match self {
            Self::Conn(conn) => conn.send(event),
            Self::Broadcast(app) => app.shared.broadcast(event),
        }
    }
}

fn error_event(message: impl Into<String>) -> Value {
    json!({"type": "error", "message": message.into()})
}

/// Flow Mode refuses every goal-authoring start.
fn refuse_flow(app: &Arc<App>, target: &Target) -> bool {
    if !app.shared.gate_active("flow") {
        return false;
    }
    target.send(error_event(
        "Flow Mode is active. Finish or stop its work first.",
    ));
    true
}

/// A Discover clone or crawl refuses every goal-authoring start.
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

/// The refusal one goal-authoring start owes the goal-run gate, if any. A
/// paused lifecycle is allowed only where the caller says so and nothing else
/// under that gate is live.
fn goal_run_refusal(app: &Arc<App>, allow_paused_lifecycle: bool) -> Option<String> {
    if !app.shared.gate_active("goal-run") {
        return None;
    }
    let reason = app.shared.gate_reason("goal-run");
    if allow_paused_lifecycle
        && app.shared.gate_paused("goal-run")
        && reason
            .as_deref()
            .is_some_and(|reason| reason.to_lowercase().contains("lifecycle"))
    {
        return None;
    }
    Some(refusal_message(reason))
}

fn refusal_message(reason: Option<String>) -> String {
    match reason.as_deref() {
        Some(text) if text.to_lowercase().contains("lifecycle") => {
            "A lifecycle run is active.".to_string()
        }
        Some(text) if text.to_lowercase().contains("manual") => {
            "A run is already active.".to_string()
        }
        Some(text) if text.to_lowercase().contains("reset") => {
            "An implementation reset is active.".to_string()
        }
        Some(text) if text.contains(" is active.") => text.to_string(),
        Some(text) => text.to_string(),
        None => "A run is already active.".to_string(),
    }
}

/// The `goalWorkLabel()` phrase a deletion refusal names for goal-run work.
fn goal_label(reason: Option<String>) -> String {
    let Some(reason) = reason else {
        return "a manual ADR run".to_string();
    };
    let lower = reason.to_lowercase();
    if lower.contains("reset") {
        return "an implementation reset".to_string();
    }
    if lower.contains("lifecycle") {
        return "the lifecycle".to_string();
    }
    if lower.contains("manual") || lower.contains("run") {
        return "a manual ADR run".to_string();
    }
    reason
}

// ---------------------------------------------------------------------------
// Skills inspection
// ---------------------------------------------------------------------------

/// The two families a managed skill can belong to.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Family {
    Prepare,
    Discover,
}

#[derive(Clone)]
struct SkillFile {
    directory: String,
    name: String,
    description: String,
    managed: bool,
    builtin: bool,
    family: Family,
    directives: Vec<Directive>,
    content: String,
}

#[derive(Clone)]
struct Directive {
    polarity: Polarity,
    text: String,
    source: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Polarity {
    Positive,
    Negative,
}

#[derive(Clone)]
struct Contradiction {
    skills: (String, String),
    directives: (String, String),
}

impl Contradiction {
    fn json(&self) -> Value {
        let mut object = Map::new();
        object.insert("skills".into(), json!([self.skills.0, self.skills.1]));
        object.insert(
            "directives".into(),
            json!([self.directives.0, self.directives.1]),
        );
        Value::Object(object)
    }
}

struct SkillsInspection {
    managed: Vec<SkillFile>,
    prepare: Vec<SkillFile>,
    discover: Vec<SkillFile>,
    unmanaged: Vec<SkillFile>,
    errors: Vec<String>,
    contradictions: Vec<Contradiction>,
    discover_states: Vec<(String, String, String, String)>,
}

impl SkillsInspection {
    fn summaries(&self) -> Vec<Value> {
        let mut rows: Vec<(String, Value)> = Vec::new();
        for skill in &self.managed {
            let state = if skill.family == Family::Discover {
                self.discover_states
                    .iter()
                    .find(|(name, _, _, _)| name == &skill.directory)
                    .map(|(_, _, state, _)| state.clone())
                    .unwrap_or_else(|| "generated".to_string())
            } else {
                "generated".to_string()
            };
            let mut object = Map::new();
            object.insert("name".into(), Value::String(skill.name.clone()));
            object.insert(
                "description".into(),
                Value::String(skill.description.clone()),
            );
            object.insert(
                "family".into(),
                Value::String(
                    match skill.family {
                        Family::Prepare => "prepare",
                        Family::Discover => "discover",
                    }
                    .to_string(),
                ),
            );
            object.insert("state".into(), Value::String(state));
            object.insert("content".into(), Value::String(skill.content.clone()));
            rows.push((skill.name.clone(), Value::Object(object)));
        }
        for (name, description, state, _) in &self.discover_states {
            if self.managed.iter().any(|skill| &skill.directory == name) {
                continue;
            }
            if state != "missing" {
                continue;
            }
            let mut object = Map::new();
            object.insert("name".into(), Value::String(name.clone()));
            object.insert("description".into(), Value::String(description.clone()));
            object.insert("family".into(), Value::String("discover".into()));
            object.insert("state".into(), Value::String(state.clone()));
            object.insert("content".into(), Value::String(String::new()));
            rows.push((name.clone(), Value::Object(object)));
        }
        rows.sort_by(|left, right| left.0.cmp(&right.0));
        rows.into_iter().map(|(_, value)| value).collect()
    }
}

/// Reads one `SKILL.md`, or `None` when the directory holds none.
async fn read_skill_at(root: &Path, directory: &str) -> Result<Option<SkillFile>, String> {
    let bytes = match tokio::fs::read(root.join(directory).join("SKILL.md")).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let content = String::from_utf8_lossy(&bytes).into_owned();
    let fields = skill_frontmatter::fields(&content).unwrap_or_default();
    let field = |key: &str| fields.get(key).map(String::as_str).unwrap_or("");
    let family = if field(FAMILY_FIELD) == "discover" {
        Family::Discover
    } else {
        Family::Prepare
    };
    Ok(Some(SkillFile {
        directory: directory.to_string(),
        name: field("name").to_string(),
        description: field("description").to_string(),
        managed: field(&format!("metadata.{MANAGED_MARKER}")) == "true",
        builtin: field(&format!("metadata.{BUILTIN_MARKER}")) == "true",
        family,
        directives: extract_directives(&content),
        content,
    }))
}

/// Whether one skills-root entry is a directory a `SKILL.md` may be read from.
async fn skill_entry_is_directory(
    root: &Path,
    name: &str,
    file_type: &std::fs::FileType,
) -> Result<bool, String> {
    if file_type.is_dir() {
        return Ok(true);
    }
    if !file_type.is_symlink() {
        return Ok(false);
    }
    match tokio::fs::metadata(root.join(name)).await {
        Ok(metadata) => Ok(metadata.is_dir()),
        Err(_) => Ok(false),
    }
}

async fn inspect_skills(root: &Path) -> Result<SkillsInspection, String> {
    let mut managed: Vec<SkillFile> = Vec::new();
    let mut prepare: Vec<SkillFile> = Vec::new();
    let mut discover: Vec<SkillFile> = Vec::new();
    let mut unmanaged: Vec<SkillFile> = Vec::new();

    let names = match read_entries(root).await {
        Ok(names) => names,
        Err(message) => return Err(message),
    };
    for (name, file_type) in names {
        if !skill_entry_is_directory(root, &name, &file_type).await? {
            continue;
        }
        let Some(skill) = read_skill_at(root, &name).await? else {
            continue;
        };
        // A link is the operator's entry, whatever marker its target carries:
        // preparing owns only directories this feature created itself.
        if skill.managed && !file_type.is_symlink() {
            if skill.family == Family::Discover {
                discover.push(skill.clone());
            } else {
                prepare.push(skill.clone());
            }
            managed.push(skill);
        } else {
            unmanaged.push(skill);
        }
    }

    let repo_dir = root
        .parent()
        .and_then(Path::parent)
        .unwrap_or(root)
        .to_path_buf();
    let discover_states = discover_skill_views(&repo_dir).await;

    let mut errors: Vec<String> = Vec::new();
    for skill in &managed {
        let label = format!("\"{}\"", skill.directory);
        if skill.name != skill.directory {
            errors.push(format!(
                "skill {label} has frontmatter name \"{}\", not the directory name.",
                skill.name
            ));
        } else if !crate::installed_skills::is_skill_name(&skill.name) {
            errors.push(format!(
                "skill {label} has an invalid name: use 1-{SKILL_NAME_MAX} lowercase letters, digits, or single hyphens."
            ));
        }
        if skill.description.trim().is_empty() {
            errors.push(format!("skill {label} has an empty description."));
        } else if skill.description.chars().count() > SKILL_DESCRIPTION_MAX {
            errors.push(format!(
                "skill {label} has a description longer than {SKILL_DESCRIPTION_MAX} characters."
            ));
        }
    }

    // Preparation's contradiction review covers its own family plus
    // hand-authored skills only: a project-specific Discover directive cannot
    // fail it.
    let mut review: Vec<&SkillFile> = Vec::new();
    review.extend(prepare.iter());
    review.extend(unmanaged.iter());
    let contradictions = find_contradictions(&review);

    Ok(SkillsInspection {
        managed,
        prepare,
        discover,
        unmanaged,
        errors,
        contradictions,
        discover_states,
    })
}

/// Every entry name with its own file type, in directory order.
async fn read_entries(root: &Path) -> Result<Vec<(String, std::fs::FileType)>, String> {
    let mut reader = match tokio::fs::read_dir(root).await {
        Ok(reader) => reader,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut entries = Vec::new();
    while let Some(entry) = reader
        .next_entry()
        .await
        .map_err(|error| error.to_string())?
    {
        let name = entry.file_name().to_string_lossy().into_owned();
        let file_type = entry.file_type().await.map_err(|error| error.to_string())?;
        entries.push((name, file_type));
    }
    Ok(entries)
}

/// The published Discover skills, as `readArtifacts` reports them. Any
/// unreadable published artifact hides them all, exactly as the reference
/// reader does.
async fn discover_skill_views(repo_dir: &Path) -> Vec<(String, String, String, String)> {
    let manifest_path = repo_dir.join(".omp").join("discover").join("manifest.json");
    let source = match tokio::fs::read_to_string(&manifest_path).await {
        Ok(source) => source,
        Err(_) => return Vec::new(),
    };
    let Ok(manifest) = serde_json::from_str::<Value>(&source) else {
        return Vec::new();
    };
    let Some(manifest) = manifest.as_object() else {
        return Vec::new();
    };
    if manifest.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Vec::new();
    }
    if manifest.get("paths").and_then(Value::as_object).is_none() {
        return Vec::new();
    }
    let Some(entries) = manifest.get("skills").and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut views = Vec::new();
    for name in DISCOVER_SKILLS {
        if !entries.iter().any(|entry| {
            entry
                .as_object()
                .and_then(|entry| entry.get("name"))
                .and_then(Value::as_str)
                == Some(name)
        }) {
            continue;
        }
        let live = read_optional_text(
            &repo_dir
                .join(".omp")
                .join("skills")
                .join(name)
                .join("SKILL.md"),
        )
        .await;
        let baseline = read_optional_text(
            &repo_dir
                .join(".omp")
                .join("discover")
                .join("skills")
                .join(name)
                .join("SKILL.md"),
        )
        .await;
        let description = live
            .as_deref()
            .or(baseline.as_deref())
            .and_then(skill_frontmatter::fields)
            .and_then(|fields| fields.get("description").cloned())
            .unwrap_or_default();
        let live_hash = live.as_deref().map(hash_text);
        let baseline_hash = baseline.as_deref().map(hash_text);
        let entry_baseline = entries
            .iter()
            .filter_map(Value::as_object)
            .find(|entry| entry.get("name").and_then(Value::as_str) == Some(name))
            .and_then(|entry| entry.get("baselineHash"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let state = match &live_hash {
            None => "missing",
            Some(hash) => {
                if baseline_hash.as_deref() == Some(hash.as_str())
                    || entry_baseline.as_deref() == Some(hash.as_str())
                {
                    "generated"
                } else {
                    "edited"
                }
            }
        };
        views.push((
            name.to_string(),
            description,
            state.to_string(),
            String::new(),
        ));
    }
    views
}

async fn read_optional_text(path: &Path) -> Option<String> {
    match tokio::fs::read(path).await {
        Ok(bytes) => Some(String::from_utf8_lossy(&bytes).into_owned()),
        Err(_) => None,
    }
}

fn hash_text(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    hex::encode(hasher.finalize())
}

fn find_contradictions(skills: &[&SkillFile]) -> Vec<Contradiction> {
    struct Entry<'a> {
        skill: &'a SkillFile,
        directive: &'a Directive,
    }
    let mut all: Vec<Entry> = Vec::new();
    for skill in skills {
        for directive in &skill.directives {
            all.push(Entry { skill, directive });
        }
    }
    let mut seen: HashSet<String> = HashSet::new();
    let mut contradictions = Vec::new();
    for left in &all {
        for right in &all {
            if left.skill.directory == right.skill.directory {
                continue;
            }
            if left.directive.polarity == right.directive.polarity {
                continue;
            }
            if left.directive.text != right.directive.text {
                continue;
            }
            let (first_directory, second_directory) =
                if left.skill.directory <= right.skill.directory {
                    (left.skill.directory.clone(), right.skill.directory.clone())
                } else {
                    (right.skill.directory.clone(), left.skill.directory.clone())
                };
            let key = format!(
                "{}\u{0}{}\u{0}{}",
                first_directory, second_directory, left.directive.text
            );
            if !seen.insert(key) {
                continue;
            }
            let (first, second) = if left.skill.directory == first_directory {
                (left, right)
            } else {
                (right, left)
            };
            contradictions.push(Contradiction {
                skills: (first_directory, second_directory),
                directives: (
                    first.directive.source.clone(),
                    second.directive.source.clone(),
                ),
            });
        }
    }
    contradictions
}

fn describe_contradictions(contradictions: &[Contradiction], managed: &[SkillFile]) -> String {
    contradictions
        .iter()
        .map(|contradiction| {
            let (first, second) = &contradiction.skills;
            let unmanaged: Vec<String> = [first, second]
                .iter()
                .filter(|name| !managed.iter().any(|skill| skill.directory == ***name))
                .map(|name| format!("\"{name}\""))
                .collect();
            let owner = if unmanaged.is_empty() {
                "two managed skills".to_string()
            } else {
                format!("unmanaged skill {}", unmanaged.join(" and "))
            };
            format!(
                "Contradiction between \"{first}\" and \"{second}\" ({owner}): \"{}\" vs \"{}\".",
                contradiction.directives.0, contradiction.directives.1
            )
        })
        .collect::<Vec<_>>()
        .join(" ")
}

// ---------------------------------------------------------------------------
// Frontmatter and directives
// ---------------------------------------------------------------------------

static DIRECTIVE_PATTERN: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r"(?i)^(always|never|must not|must|should not|should|do not|don't|avoid|prefer|use)\s+(.+)$",
    )
    .expect("the directive pattern is valid")
});

fn directive_pattern() -> &'static regex::Regex {
    &DIRECTIVE_PATTERN
}

fn normalize_directive(text: &str) -> String {
    let mut normalized: String = text
        .to_lowercase()
        .chars()
        .filter(|character| !matches!(character, '`' | '*' | '_' | '~'))
        .collect();
    while normalized.ends_with(['.', '!', '?', ';', ':', ',']) {
        normalized.pop();
    }
    let normalized = normalized.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut value = normalized.as_str();
    for prefix in ["to use ", "to ", "use "] {
        if let Some(rest) = value.strip_prefix(prefix) {
            value = rest;
        }
    }
    value.to_string()
}

fn strip_heading(text: &str) -> &str {
    let hashes = text
        .chars()
        .take_while(|character| *character == '#')
        .count();
    if !(1..=6).contains(&hashes) {
        return text;
    }
    let rest = &text[hashes..];
    let whitespace = rest
        .chars()
        .take_while(|character| character.is_whitespace())
        .count();
    if whitespace == 0 {
        return text;
    }
    &rest[whitespace..]
}

fn strip_quote(text: &str) -> &str {
    let Some(rest) = text.strip_prefix('>') else {
        return text;
    };
    match rest.chars().next() {
        Some(character) if character.is_whitespace() => &rest[character.len_utf8()..],
        _ => rest,
    }
}

fn strip_bullet(text: &str) -> &str {
    if let Some(first) = text.chars().next().filter(|c| matches!(c, '-' | '*' | '+')) {
        let rest = &text[first.len_utf8()..];
        let whitespace = rest
            .chars()
            .take_while(|character| character.is_whitespace())
            .count();
        if whitespace > 0 {
            return &rest[whitespace..];
        }
        return text;
    }
    let digits = text
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .count();
    if digits == 0 {
        return text;
    }
    let rest = &text[digits..];
    let Some(marker) = rest.chars().next() else {
        return text;
    };
    if marker != '.' && marker != ')' {
        return text;
    }
    let after = &rest[marker.len_utf8()..];
    let whitespace = after
        .chars()
        .take_while(|character| character.is_whitespace())
        .count();
    if whitespace == 0 {
        return text;
    }
    &after[whitespace..]
}

fn extract_directives(source: &str) -> Vec<Directive> {
    let mut directives = Vec::new();
    let mut fenced = false;
    for line in skill_frontmatter::lines(skill_frontmatter::body(source)) {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        let text = line.trim();
        let text = strip_heading(text);
        let text = strip_quote(text);
        let text = strip_bullet(text);
        if text.is_empty() {
            continue;
        }
        let Some(captures) = directive_pattern().captures(text) else {
            continue;
        };
        let marker = captures
            .get(1)
            .map(|group| group.as_str().to_lowercase())
            .unwrap_or_default();
        let subject =
            normalize_directive(captures.get(2).map(|group| group.as_str()).unwrap_or(""));
        if subject.is_empty() {
            continue;
        }
        let polarity = match marker.as_str() {
            "never" | "must not" | "should not" | "do not" | "don't" | "avoid" => {
                Polarity::Negative
            }
            _ => Polarity::Positive,
        };
        directives.push(Directive {
            polarity,
            text: subject,
            source: text.to_string(),
        });
    }
    directives
}

// ---------------------------------------------------------------------------
// Skills directory snapshots
// ---------------------------------------------------------------------------

#[derive(Clone, Default)]
struct SkillsSnapshot {
    exists: bool,
    files: Vec<(String, Vec<u8>)>,
    symlinks: Vec<(String, String)>,
}

async fn snapshot_directory(root: &Path) -> std::io::Result<SkillsSnapshot> {
    let mut snapshot = SkillsSnapshot::default();
    match tokio::fs::metadata(root).await {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => return Ok(snapshot),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(snapshot),
        Err(error) => return Err(error),
    }
    snapshot.exists = true;
    walk_snapshot(root, "", &mut snapshot).await?;
    Ok(snapshot)
}

async fn walk_snapshot(
    root: &Path,
    relative: &str,
    snapshot: &mut SkillsSnapshot,
) -> std::io::Result<()> {
    let directory = if relative.is_empty() {
        root.to_path_buf()
    } else {
        root.join(relative)
    };
    let mut reader = tokio::fs::read_dir(&directory).await?;
    let mut entries = Vec::new();
    while let Some(entry) = reader.next_entry().await? {
        entries.push(entry);
    }
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let next = if relative.is_empty() {
            name.clone()
        } else {
            format!("{relative}/{name}")
        };
        let file_type = entry.file_type().await?;
        // A link is recorded, never followed: its target belongs to whoever
        // created it, and descending would snapshot bytes this feature cannot
        // write back as a link.
        if file_type.is_symlink() {
            let target = tokio::fs::read_link(entry.path()).await?;
            snapshot
                .symlinks
                .push((next, target.to_string_lossy().into_owned()));
        } else if file_type.is_dir() {
            Box::pin(walk_snapshot(root, &next, snapshot)).await?;
        } else if file_type.is_file() {
            let bytes = tokio::fs::read(entry.path()).await?;
            snapshot.files.push((next, bytes));
        }
    }
    Ok(())
}

fn capture_snapshot(snapshot: &SkillsSnapshot) -> Value {
    let engine = base64::engine::general_purpose::STANDARD;
    let mut object = Map::new();
    object.insert("exists".into(), Value::Bool(snapshot.exists));
    object.insert(
        "files".into(),
        Value::Array(
            snapshot
                .files
                .iter()
                .map(|(relative, bytes)| json!([relative, engine.encode(bytes)]))
                .collect(),
        ),
    );
    object.insert(
        "symlinks".into(),
        Value::Array(
            snapshot
                .symlinks
                .iter()
                .map(|(relative, target)| json!([relative, target]))
                .collect(),
        ),
    );
    Value::Object(object)
}

fn parse_snapshot(value: &Value) -> Option<SkillsSnapshot> {
    let record = value.as_object()?;
    let pairs = |entries: Option<&Value>| -> Vec<(String, String)> {
        let Some(Value::Array(entries)) = entries else {
            return Vec::new();
        };
        let mut pairs = Vec::new();
        for entry in entries {
            let Value::Array(pair) = entry else {
                continue;
            };
            let (Some(relative), Some(content)) = (pair.first(), pair.get(1)) else {
                continue;
            };
            let (Some(relative), Some(content)) = (relative.as_str(), content.as_str()) else {
                continue;
            };
            pairs.push((relative.to_string(), content.to_string()));
        }
        pairs
    };
    let engine = base64::engine::general_purpose::STANDARD;
    Some(SkillsSnapshot {
        exists: record
            .get("exists")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        files: pairs(record.get("files"))
            .into_iter()
            .map(|(relative, content)| {
                let bytes = engine.decode(content.as_bytes()).unwrap_or_default();
                (relative, bytes)
            })
            .collect(),
        symlinks: pairs(record.get("symlinks")),
    })
}

fn snapshot_skill_directories(snapshot: &SkillsSnapshot) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    for (relative, _) in &snapshot.files {
        if let Some(index) = relative.find('/') {
            names.insert(relative[..index].to_string());
        }
    }
    for (relative, _) in &snapshot.symlinks {
        if let Some(directory) = relative.split('/').next() {
            names.insert(directory.to_string());
        }
    }
    names
}

async fn managed_skill_names(
    root: &Path,
    snapshot: &SkillsSnapshot,
) -> Result<Vec<String>, String> {
    let mut names = Vec::new();
    for (relative, _) in &snapshot.files {
        let Some((directory, rest)) = relative.split_once('/') else {
            continue;
        };
        if rest != "SKILL.md" {
            continue;
        }
        let Some(skill) = read_skill_at(root, directory).await? else {
            continue;
        };
        if skill.managed && skill.family == Family::Prepare {
            names.push(directory.to_string());
        }
    }
    Ok(names)
}

async fn restore_directory(root: &Path, snapshot: &SkillsSnapshot) -> std::io::Result<()> {
    remove_path(root).await?;
    if !snapshot.exists {
        return Ok(());
    }
    tokio::fs::create_dir_all(root).await?;
    for (relative, target) in &snapshot.symlinks {
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                tokio::fs::create_dir_all(parent).await?;
            }
        }
        tokio::fs::symlink(target, &path).await?;
    }
    for (relative, bytes) in &snapshot.files {
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                tokio::fs::create_dir_all(parent).await?;
            }
        }
        tokio::fs::write(&path, bytes).await?;
    }
    Ok(())
}

fn restore_directory_sync(root: &Path, snapshot: &SkillsSnapshot) -> std::io::Result<()> {
    remove_path_sync(root)?;
    if !snapshot.exists {
        return Ok(());
    }
    std::fs::create_dir_all(root)?;
    for (relative, target) in &snapshot.symlinks {
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        std::os::unix::fs::symlink(target, &path)?;
    }
    for (relative, bytes) in &snapshot.files {
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        std::fs::write(&path, bytes)?;
    }
    Ok(())
}

fn remove_path_sync(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(_) => Err(error),
        },
    }
}

/// Removes one path whether it is a file, a link, or a directory tree.
async fn remove_path(path: &Path) -> std::io::Result<()> {
    match tokio::fs::remove_dir_all(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => match tokio::fs::remove_file(path).await {
            Ok(()) => Ok(()),
            Err(_) => Err(error),
        },
    }
}

// ---------------------------------------------------------------------------
// Activity bounds
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

fn revision_prompt(goal_file: &Path, request: Option<&str>) -> String {
    let goal = goal_file.to_string_lossy();
    let guidance = request.map(str::trim).unwrap_or("");
    let mut lines = vec![
        "## Manifesto".to_string(),
        String::new(),
        format!(
            "Your goal is to revise the project goal at {goal} with the developer, and the observable"
        ),
        "result is that file holding the complete revised goal text.".to_string(),
        String::new(),
        format!("Revise the goal in {goal}."),
        "Ask the developer any questions you need, one at a time.".to_string(),
        "When the revision is complete, write the complete revised goal text to that file and end the turn."
            .to_string(),
    ];
    if !guidance.is_empty() {
        lines.push(String::new());
        lines.push(format!("Guidance: {guidance}"));
    }
    lines.join("\n")
}

async fn read_goal_snapshot(path: &Path) -> std::io::Result<Option<String>> {
    match tokio::fs::read_to_string(path).await {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn creation_goal_path(app: &Arc<App>) -> PathBuf {
    crate::goal::default_goal_path(&app.config().repo_dir)
}

fn skills_directory(app: &Arc<App>) -> PathBuf {
    crate::installed_skills::skills_root(&app.config().repo_dir)
}

/// Writes the state directly, as `persistState` does before a peer starts.
fn persist_now(app: &Arc<App>) {
    let text = crate::state::state_envelope(&app.shared.state_value());
    let _ = crate::state::write_state_file(app.shared.state_path(), &text);
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
    let message = record.get("message")?.as_str()?.to_string();
    let id = record.get("id")?;
    if !matches!(id, Value::String(_) | Value::Number(_)) {
        return None;
    }
    let options = match record.get("options") {
        Some(Value::Array(options)) => options
            .iter()
            .filter(|option| {
                option
                    .as_object()
                    .is_some_and(|option| option.contains_key("label"))
            })
            .cloned()
            .collect(),
        _ => Vec::new(),
    };
    Some(RunQuestion {
        id: id.clone(),
        message,
        options,
    })
}

fn parse_names(value: Option<&Value>) -> Option<Vec<String>> {
    let values = value?.as_array()?;
    Some(
        values
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
    )
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A repository fixture whose skills root holds the written documents.
    fn scratch(label: &str) -> (PathBuf, PathBuf) {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!("goal-authoring-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&repo);
        let skills = repo.join(".omp").join("skills");
        std::fs::create_dir_all(&skills).expect("a fixture skills root");
        (repo, skills)
    }

    fn write_skill(root: &Path, name: &str, source: &str) {
        let directory = root.join(name);
        std::fs::create_dir_all(&directory).expect("a skill directory");
        std::fs::write(directory.join("SKILL.md"), source).expect("a SKILL.md");
    }

    /// One `SKILL.md` carrying a UTF-8 byte-order mark, as an editor saving it
    /// that way writes it.
    fn marked_skill(name: &str, managed: bool, directive: &str) -> String {
        let mut source = format!("\u{feff}---\nname: {name}\ndescription: Guidance for {name}.\n");
        if managed {
            source.push_str("metadata:\n  devboard-managed: \"true\"\n");
        }
        source.push_str(&format!("---\n\n# {name}\n\n- {directive}\n"));
        source
    }

    #[tokio::test]
    async fn a_byte_order_mark_keeps_the_marker_and_the_body() {
        let (_repo, skills) = scratch("bom-skill");
        write_skill(
            &skills,
            "bommed",
            &marked_skill("bommed", true, "Always keep the fence in one place."),
        );

        let skill = read_skill_at(&skills, "bommed")
            .await
            .expect("a readable skill")
            .expect("a skill row");

        assert!(skill.managed);
        assert_eq!(skill.name, "bommed");
        assert_eq!(skill.description, "Guidance for bommed.");
        // The frontmatter is bookkeeping, so no directive comes out of it.
        assert_eq!(skill.directives.len(), 1);
        assert_eq!(
            skill.directives[0].source,
            "Always keep the fence in one place."
        );
        assert_eq!(
            skill_frontmatter::body(&skill.content),
            "\n# bommed\n\n- Always keep the fence in one place.\n"
        );
    }

    #[tokio::test]
    async fn inspection_lists_a_marked_skill_and_reviews_its_directives() {
        let (_repo, skills) = scratch("bom-inspection");
        write_skill(
            &skills,
            "bommed",
            &marked_skill("bommed", true, "Always keep the fence in one place."),
        );
        write_skill(
            &skills,
            "plain",
            &marked_skill("plain", false, "Never keep the fence in one place."),
        );

        let inspection = inspect_skills(&skills).await.expect("a skills inspection");

        assert!(inspection.errors.is_empty(), "{:?}", inspection.errors);
        let summaries = inspection.summaries();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0]["name"], "bommed");
        assert_eq!(summaries[0]["family"], "prepare");
        assert_eq!(inspection.contradictions.len(), 1);
        assert_eq!(
            inspection.contradictions[0].skills,
            ("bommed".to_string(), "plain".to_string())
        );
    }
}
