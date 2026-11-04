//! The dashboard application behind the HTTP surface.
//!
//! [`Shared`] owns what every flow needs: the connected clients, the journal,
//! the resolved configuration, and the one state-file writer. Each flow module
//! keeps its own state and holds `Arc<Shared>` to broadcast and persist.
//! [`App`] dispatches every client command to the flow that answers it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::http::{HeaderMap, Method};
use serde_json::{json, Value};
use url::Url;

use crate::config::Config;
use crate::http::{presented_credential, request_refusal, Replies};
use crate::journal::Journal;
use crate::protocol::Command;

/// One connected client's handle.
#[derive(Clone)]
pub struct Conn {
    id: u64,
    outbox: crate::http::Outbox,
}

impl Conn {
    pub fn new(outbox: crate::http::Outbox) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        Self {
            id: NEXT.fetch_add(1, Ordering::Relaxed),
            outbox,
        }
    }

    pub fn id(&self) -> u64 {
        self.id
    }

    /// Sends one event; a closed socket drops it.
    pub fn send(&self, event: Value) {
        let _ = self.outbox.send(crate::jsjson::stringify(&event));
    }
}

/// One durable state section. A flow writes its own key and restores it; the
/// envelope and the write ordering belong to [`Shared`].
pub trait StateSection: Send + Sync {
    /// The state this flow would restore from now.
    fn snapshot(&self) -> Option<Value> {
        None
    }

    /// Applies one restored value. A section never fails construction over
    /// unusable state; it keeps what it can parse and ignores the rest.
    fn restore(&self, _value: &Value) {}
}

/// What one mode reports about live work, so another mode can refuse to start
/// beside it or preempt it exactly as the TypeScript dashboard does.
pub trait ModeGate: Send + Sync {
    /// Whether this mode holds work a start would collide with.
    fn has_active_work(&self) -> bool;

    /// The refusal reason when this mode is busy, in the TypeScript wording.
    fn busy_reason(&self) -> Option<String>;

    /// Ends the work a reset or creation preempts.
    fn abort_active_work(&self);

    /// Whether this mode holds a run that is paused, so some commands may
    /// still start beside it. A mode without pausing reports false.
    fn paused(&self) -> bool {
        false
    }
}

/// The state every flow shares.
pub struct Shared {
    pub config: Config,
    pub journal: Journal,
    clients: Mutex<HashMap<u64, Conn>>,
    pub token: String,
    pub allowed_hostnames: std::collections::HashSet<String>,
    state_path: PathBuf,
    sections: Mutex<Vec<(String, Arc<dyn StateSection>)>>,
    last_saved: Mutex<Option<String>>,
    /// Signalled when this process is about to be replaced.
    pub shutdown: tokio::sync::Notify,
    /// The live-work gates each mode registers.
    gates: Mutex<Vec<(String, Arc<dyn ModeGate>)>>,
    /// Hooks that follow every app-level broadcast, like the TypeScript
    /// `syncDiscoverBusy()` call inside `broadcast`.
    broadcast_hooks: Mutex<Vec<Arc<dyn Fn() + Send + Sync>>>,
    /// Serializes whole-state writes; the TypeScript event loop was
    /// single-threaded, so two broadcasts never interleaved.
    persist_lock: Mutex<()>,
}

impl Shared {
    /// Every event a client can observe leaves after the state that produced
    /// it is on disk.
    pub fn broadcast(&self, event: Value) {
        self.persist(&event);
        let payload = crate::jsjson::stringify(&event);
        if let Ok(clients) = self.clients.lock() {
            for conn in clients.values() {
                let _ = conn.outbox.send(payload.clone());
            }
        }
        if let Ok(hooks) = self.broadcast_hooks.lock() {
            for hook in hooks.iter() {
                hook();
            }
        }
    }

    /// Registers one hook that runs after every app-level broadcast.
    pub fn add_broadcast_hook(&self, hook: Arc<dyn Fn() + Send + Sync>) {
        if let Ok(mut hooks) = self.broadcast_hooks.lock() {
            hooks.push(hook);
        }
    }

    /// Sends one event to every client except `except`.
    pub fn send_all(&self, event: Value, except: Option<u64>) {
        let payload = crate::jsjson::stringify(&event);
        if let Ok(clients) = self.clients.lock() {
            for conn in clients.values() {
                if Some(conn.id()) == except {
                    continue;
                }
                let _ = conn.outbox.send(payload.clone());
            }
        }
    }

    /// Whether at least one client is connected.
    pub fn has_clients(&self) -> bool {
        self.clients
            .lock()
            .map(|clients| !clients.is_empty())
            .unwrap_or(false)
    }

    /// The number of connected clients.
    pub fn client_count(&self) -> usize {
        self.clients
            .lock()
            .map(|clients| clients.len())
            .unwrap_or(0)
    }

    /// Registers one mode's live-work gate under its stable name.
    pub fn register_gate(&self, name: &str, gate: Arc<dyn ModeGate>) {
        if let Ok(mut gates) = self.gates.lock() {
            gates.retain(|(existing, _)| existing != name);
            gates.push((name.to_string(), gate));
        }
    }

    /// Whether one named mode holds active work.
    pub fn gate_active(&self, name: &str) -> bool {
        self.gates
            .lock()
            .ok()
            .and_then(|gates| {
                gates
                    .iter()
                    .find(|(existing, _)| existing == name)
                    .map(|(_, gate)| gate.has_active_work())
            })
            .unwrap_or(false)
    }

    /// One named mode's busy reason.
    pub fn gate_reason(&self, name: &str) -> Option<String> {
        self.gates.lock().ok().and_then(|gates| {
            gates
                .iter()
                .find(|(existing, _)| existing == name)
                .and_then(|(_, gate)| gate.busy_reason())
        })
    }

    /// Whether one named mode holds a paused run.
    pub fn gate_paused(&self, name: &str) -> bool {
        self.gates
            .lock()
            .ok()
            .and_then(|gates| {
                gates
                    .iter()
                    .find(|(existing, _)| existing == name)
                    .map(|(_, gate)| gate.paused())
            })
            .unwrap_or(false)
    }

    /// The first busy reason any mode reports, in registration order.
    pub fn busy_reason(&self) -> Option<String> {
        let gates = self.gates.lock().ok()?;
        gates.iter().find_map(|(_, gate)| gate.busy_reason())
    }

    /// Ends the work one named mode holds, leaving the others alone.
    pub fn abort_gate(&self, name: &str) {
        if let Ok(gates) = self.gates.lock() {
            if let Some((_, gate)) = gates.iter().find(|(existing, _)| existing == name) {
                gate.abort_active_work();
            }
        }
    }

    /// Ends the work every mode says a reset or creation preempts.
    pub fn abort_all_work(&self) {
        if let Ok(gates) = self.gates.lock() {
            for (_, gate) in gates.iter() {
                gate.abort_active_work();
            }
        }
    }

    /// Registers one durable section under its envelope key.
    pub fn register_section(&self, key: &str, section: Arc<dyn StateSection>) {
        if let Ok(mut sections) = self.sections.lock() {
            sections.push((key.to_string(), section));
        }
    }

    /// Restores every registered section from the state file. A damaged file
    /// stays preserved aside and every section starts empty.
    pub fn restore(&self) {
        let value = match crate::state::read_state_file(&self.state_path) {
            crate::state::StateLoad::Loaded(value) => value,
            crate::state::StateLoad::Missing => return,
            crate::state::StateLoad::Damaged { reason, preserved } => {
                let detail = match preserved {
                    Some(path) => format!("{reason}; preserved at {}", path.display()),
                    None => reason,
                };
                self.journal
                    .write("server-error", &format!("state: {detail}"), None);
                return;
            }
        };
        let Ok(sections) = self.sections.lock() else {
            return;
        };
        let Some(object) = value.as_object() else {
            return;
        };
        for (key, section) in sections.iter() {
            if let Some(section_value) = object.get(key) {
                section.restore(section_value);
            }
        }
    }

    /// The whole state the sections would restore from now.
    pub fn state_value(&self) -> Value {
        let base = crate::state::default_state();
        let mut state = match base {
            Value::Object(state) => state,
            _ => serde_json::Map::new(),
        };
        if let Ok(sections) = self.sections.lock() {
            for (key, section) in sections.iter() {
                if let Some(value) = section.snapshot() {
                    state.insert(key.clone(), value);
                }
            }
        }
        Value::Object(state)
    }

    /// Replaces the state file with the current state, skipping a write when
    /// nothing changed.
    fn persist(&self, _event: &Value) {
        let _write = self.persist_lock.lock();
        let text = crate::state::state_envelope(&self.state_value());
        if let Ok(mut last) = self.last_saved.lock() {
            if last.as_deref() == Some(text.as_str()) {
                return;
            }
            *last = Some(text.clone());
        }
        if let Err(error) = crate::state::write_state_file(&self.state_path, &text) {
            eprintln!(
                "state: could not write {}: {error}",
                self.state_path.display()
            );
        }
    }

    pub fn state_path(&self) -> &Path {
        &self.state_path
    }
}

fn config_state_dir(shared: &Arc<Shared>) -> PathBuf {
    shared.config.state_dir.clone()
}

fn config_repo_dir(shared: &Arc<Shared>) -> PathBuf {
    shared.config.repo_dir.clone()
}

/// The dashboard application.
pub struct App {
    pub shared: Arc<Shared>,
    pub idempotency: crate::idempotency::IdempotencyStore,
    /// Identifies this dashboard instance to the detached-run owners.
    pub instance: String,
    /// The version this process loaded at startup.
    pub running_version: Option<String>,
    /// The newest release the update check has seen.
    latest_version: Mutex<Option<String>>,
    /// A replacement that could not start; the process keeps serving.
    replacement_failure: Mutex<Option<String>>,
    /// One automatic replacement attempt per installed version.
    attempted_replacement: Mutex<Option<String>>,
    updater: Mutex<Option<crate::updates::Updater>>,
    /// The operator's provider credentials and the per-peer selection.
    pub providers: crate::providers::ProviderService,
    /// The daily complexity snapshot controller for this dashboard.
    pub complexity: Arc<crate::complexity::ComplexitySnapshots>,
    /// The dashboard's own handle, for modes that hold a shared reference.
    weak_self: std::sync::Weak<App>,
    /// Replaces this process; absent means the dashboard has no launcher.
    restart_hook: Mutex<Option<Arc<dyn Fn() -> Result<(), String> + Send + Sync>>>,
    source_refresher: Mutex<Option<crate::source_refresh::SourceRefresher>>,
    restart_when_idle: Arc<std::sync::atomic::AtomicBool>,
    /// ACP children the previous process recorded for its replacement to end.
    restored_children: Mutex<Vec<crate::detached_run::RecordedChild>>,
}

impl App {
    pub fn new(config: Config, journal: Journal) -> Arc<Self> {
        let allowed_hostnames =
            crate::http::allowed_request_hostnames(&config.hostname, &config.allowed_hosts);
        let token = config.token.clone();
        let idempotency =
            crate::idempotency::IdempotencyStore::open(&config.state_dir, &config.repo_dir);
        let instance = uuid::Uuid::new_v4().to_string();
        let state_path = crate::state::state_file(&config.state_dir, &config.repo_dir);
        let _ = crate::detached_run::write_detached_lease(
            &config.state_dir,
            &config.repo_dir,
            &instance,
        );
        let shared = Arc::new(Shared {
            config,
            journal,
            clients: Mutex::new(HashMap::new()),
            token,
            allowed_hostnames,
            state_path,
            sections: Mutex::new(Vec::new()),
            last_saved: Mutex::new(None),
            shutdown: tokio::sync::Notify::new(),
            gates: Mutex::new(Vec::new()),
            broadcast_hooks: Mutex::new(Vec::new()),
            persist_lock: Mutex::new(()),
        });
        let running_version = std::env::var("DEVBOARD_RUNNING_VERSION")
            .ok()
            .filter(|value| !value.is_empty())
            .or_else(|| {
                crate::version::read_harness_version(&crate::version::running_harness_dir())
            });
        let providers = crate::providers::ProviderService::new(
            config_state_dir(&shared),
            config_repo_dir(&shared),
            |line| eprintln!("{line}"),
        );
        let complexity = Arc::new(crate::complexity::ComplexitySnapshots::new(
            crate::complexity::ComplexityOptions::production(
                config_state_dir(&shared),
                config_repo_dir(&shared),
            ),
        ));
        let app = Arc::new_cyclic(|weak| Self {
            weak_self: weak.clone(),
            shared,
            idempotency,
            instance,
            running_version,
            latest_version: Mutex::new(None),
            replacement_failure: Mutex::new(None),
            attempted_replacement: Mutex::new(None),
            updater: Mutex::new(None),
            providers,
            complexity,
            restart_hook: Mutex::new(None),
            source_refresher: Mutex::new(None),
            restart_when_idle: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            restored_children: Mutex::new(Vec::new()),
        });
        {
            let weak = Arc::downgrade(&app);
            app.providers.set_broadcast(Arc::new(move |event| {
                if let Some(app) = weak.upgrade() {
                    app.broadcast(event);
                }
            }));
        }
        crate::goal_authoring::init(&app);
        crate::goal_run::init(&app);
        crate::flow_mode::init(&app);
        crate::discover_mode::init(&app);
        crate::issues_mode::init(&app);
        crate::agents_mode::init(&app);
        crate::ask_mode::init(&app);
        app.register_restart_section();
        app.register_children_section();
        app.shared.restore();
        app.terminate_restored_children();
        app.start_lease_refresh();
        app
    }

    pub fn config(&self) -> &Config {
        &self.shared.config
    }

    /// Refreshes the lease every second while this dashboard lives.
    fn start_lease_refresh(self: &Arc<Self>) {
        let shared = Arc::clone(&self.shared);
        let instance = self.instance.clone();
        tokio::spawn(async move {
            let mut timer = tokio::time::interval(std::time::Duration::from_secs(1));
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                timer.tick().await;
                let _ = crate::detached_run::write_detached_lease(
                    &shared.config.state_dir,
                    &shared.config.repo_dir,
                    &instance,
                );
            }
        });
    }

    pub async fn register(&self, conn: Conn) {
        if let Ok(mut clients) = self.shared.clients.lock() {
            clients.insert(conn.id(), conn);
        }
    }

    pub async fn unregister(&self, id: u64) {
        if let Ok(mut clients) = self.shared.clients.lock() {
            clients.remove(&id);
        }
    }

    /// This application as a shared handle for a mode that needs one.
    pub fn arc_self(&self) -> Arc<App> {
        self.weak_self
            .upgrade()
            .unwrap_or_else(|| unreachable!("the application outlives its modes"))
    }

    /// Sends one event to every client.
    pub fn broadcast(&self, event: Value) {
        self.shared.broadcast(event);
    }

    /// The frames a client owes on connect, before its own replies.
    pub async fn open(&self, conn: &Conn) {
        self.replay(conn);
    }

    fn replay(&self, conn: &Conn) {
        self.providers.replay(conn);
        crate::goal_authoring::replay(&self.arc_self(), conn);
        crate::goal_run::replay(&self.arc_self(), conn);
        crate::flow_mode::replay(&self.arc_self(), conn);
        crate::discover_mode::replay(&self.arc_self(), conn);
        crate::issues_mode::replay(&self.arc_self(), conn);
        crate::agents_mode::replay(&self.arc_self(), conn);
        crate::ask_mode::replay(&self.arc_self(), conn);
    }

    pub async fn close(&self, conn: &Conn) {
        self.complexity.unsubscribe(conn.id());
        crate::ask_mode::disconnect(&self.arc_self(), conn);
    }

    /// Applies one client command.
    pub async fn command(&self, conn: &Conn, command: Command) {
        if let Err(error) = self.dispatch(conn, command).await {
            conn.send(json!({"type": "error", "message": error}));
        }
    }

    async fn dispatch(&self, conn: &Conn, command: Command) -> Result<(), String> {
        if !command.is_read_only() && crate::goal_run::reset_is_active(&self.arc_self()) {
            conn.send(json!({
                "type": "error",
                "message": "An implementation reset is active.",
            }));
            return Ok(());
        }
        match command {
            Command::GetProject => {
                conn.send(
                    json!({"type": "project", "path": project_label(&self.config().repo_dir)}),
                );
                Ok(())
            }
            Command::GetVersion => {
                conn.send(self.version_state());
                Ok(())
            }
            Command::GetGoal => {
                match crate::goal::read_goal(&self.config().goal_file).await {
                    Ok(text) => conn.send(json!({"type": "goal", "text": text})),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        conn.send(json!({"type": "goal", "text": ""}));
                    }
                    Err(error) => {
                        conn.send(json!({
                            "type": "error",
                            "message": format!("Could not read the goal: {error}"),
                        }));
                    }
                }
                Ok(())
            }
            Command::ListRecords => match crate::records::read_records(&self.config().addr_dir) {
                Ok((records, next)) => {
                    conn.send(json!({"type": "records", "records": records, "next": next}));
                    Ok(())
                }
                Err(error) => Err(error),
            },
            Command::RestartServer { when_idle } => {
                if self
                    .restart_hook
                    .lock()
                    .map(|hook| hook.is_none())
                    .unwrap_or(true)
                {
                    conn.send(json!({"type": "error", "message": "Restarting the server is not available."}));
                    return Ok(());
                }
                let when_idle = when_idle.as_ref().and_then(Value::as_bool).unwrap_or(false);
                if when_idle && self.shared.busy_reason().is_some() {
                    self.arc_self().hold_restart_until_idle();
                    return Ok(());
                }
                match self.begin_restart() {
                    Ok(()) => {}
                    Err(message) => conn.send(json!({"type": "error", "message": message})),
                }
                Ok(())
            }
            Command::GetMcpTools => {
                let catalog = crate::mcp::tool_list_payload();
                let invocations = crate::mcp::tool_invocation_counts(
                    &self.config().state_dir,
                    &self.config().repo_dir,
                );
                conn.send(json!({
                    "type": "mcpTools",
                    "tools": catalog.get("tools").cloned().unwrap_or(Value::Array(Vec::new())),
                    "invocations": invocations,
                }));
                Ok(())
            }
            Command::GetInstalledSkills => {
                conn.send(
                    crate::installed_skills::installed_skills_payload(&self.config().repo_dir)
                        .await,
                );
                Ok(())
            }
            Command::GetComplexity => {
                self.complexity.subscribe(conn);
                conn.send(self.complexity.state_event());
                Ok(())
            }
            Command::SetInstalledSkillEnabled { name, enabled } => {
                match crate::installed_skills::toggle_installed_skill(
                    &self.config().repo_dir,
                    name.as_ref(),
                    enabled.as_ref(),
                )
                .await
                {
                    crate::installed_skills::ToggleOutcome::Changed(frame) => self.broadcast(frame),
                    crate::installed_skills::ToggleOutcome::Refused(frames) => {
                        for frame in frames {
                            conn.send(frame);
                        }
                    }
                }
                Ok(())
            }
            other => {
                let app = self.arc_self();
                if crate::goal_authoring::handle(&app, conn, &other).await {
                    return Ok(());
                }
                if crate::goal_run::handle(&app, conn, &other).await {
                    return Ok(());
                }
                if crate::flow_mode::handle(&app, conn, &other).await {
                    return Ok(());
                }
                if crate::discover_mode::handle(&app, conn, &other).await {
                    return Ok(());
                }
                if crate::issues_mode::handle(&app, conn, &other).await {
                    return Ok(());
                }
                if crate::agents_mode::handle(&app, conn, &other).await {
                    return Ok(());
                }
                if crate::ask_mode::handle(&app, conn, &other).await {
                    return Ok(());
                }
                if self.providers.handle(conn, &other).await {
                    return Ok(());
                }
                if crate::goal_drafts::handle(conn, &self.config().repo_dir, &other) {
                    return Ok(());
                }
                Err(format!("{} is not implemented yet", other.name()))
            }
        }
    }

    /// The `versionState` frame `getVersion` answers.
    pub fn version_state(&self) -> Value {
        let latest = self
            .latest_version
            .lock()
            .ok()
            .and_then(|latest| latest.clone());
        let mut state = crate::version::server_version(
            &self.config().repo_dir,
            self.running_version.clone(),
            latest,
        );
        if let Ok(failure) = self.replacement_failure.lock() {
            if let Some(error) = failure.clone() {
                state.replacement = Some(crate::version::ReplacementFailure {
                    running: state.running.clone(),
                    installed: state.installed.clone(),
                    error,
                });
            }
        }
        state.to_json(self.feedback_enabled())
    }

    /// Starts the publish-only source-refresh watcher.
    pub fn start_source_refresh(self: &Arc<Self>) {
        let refresher = crate::source_refresh::start(Arc::clone(self));
        if let Ok(mut slot) = self.source_refresher.lock() {
            *slot = Some(refresher);
        }
    }

    /// Starts the automatic update check for this process.
    pub fn start_updater(self: &Arc<Self>) {
        let updater = crate::updates::start(Arc::clone(self));
        if let Ok(mut slot) = self.updater.lock() {
            *slot = Some(updater);
        }
    }

    /// Starts the daily complexity snapshot check for this process.
    pub fn start_complexity(self: &Arc<Self>) {
        self.complexity.begin();
    }

    /// Records the newest release a check has seen.
    pub fn note_latest_version(&self, version: &str) {
        if let Ok(mut latest) = self.latest_version.lock() {
            *latest = Some(version.to_string());
        }
    }

    /// Journals one failure with its scope.
    pub fn journal_error(&self, kind: &str, text: &str) {
        self.shared.journal.write(kind, text, None);
        eprintln!("{text}");
    }

    /// Syncs the host's managed copies from the installed harness.
    pub fn sync_host_copies(&self) -> anyhow::Result<()> {
        let report = crate::cli_install::install(Some(&self.config().repo_dir), false)?;
        if report.agents.as_str() == "drift" {
            self.shared
                .journal
                .write("update", "AGENTS.md differs from the template", None);
        }
        Ok(())
    }

    /// Tells every page to wait for a replacement and hands detached runs
    /// over, before this process stops serving.
    pub fn prepare_replacement(&self) {
        crate::detached_run::begin_detached_handoff(
            &self.config().state_dir,
            &self.config().repo_dir,
            &self.instance,
        );
        crate::goal_drafts::handoff_goal_draft_runs(
            &self.config().state_dir,
            &self.config().repo_dir,
        );
        self.shared.broadcast(json!({"type": "serverRestarting"}));
    }

    /// Replaces this process with the installed harness, once per version.
    pub fn replace_with_installed(self: &Arc<Self>, version: &str) {
        {
            let Ok(mut attempted) = self.attempted_replacement.lock() else {
                return;
            };
            if attempted.as_deref() == Some(version) {
                return;
            }
            *attempted = Some(version.to_string());
        }
        self.shared.journal.write(
            "update",
            &format!(
                "replacing {} with {version}",
                self.running_version.as_deref().unwrap_or("unknown")
            ),
            None,
        );
        self.prepare_replacement();
        let app = self.clone();
        let version = version.to_string();
        tokio::spawn(async move {
            let settings = crate::relaunch::RelaunchSettings::from_config(app.config());
            let ready_file = app
                .config()
                .state_dir
                .join("replacement")
                .join(format!("ready-{}.json", std::process::id()));
            match crate::relaunch::relaunch_confirmed(
                &settings,
                &ready_file,
                15_000,
                Some(&version),
            )
            .await
            {
                Ok(()) => {
                    app.shared.shutdown.notify_waiters();
                    std::process::exit(0);
                }
                Err(error) => {
                    app.shared.journal.write(
                        "update-error",
                        &format!("could not replace the server with {version}: {error}"),
                        None,
                    );
                    if let Ok(mut failure) = app.replacement_failure.lock() {
                        *failure = Some(error);
                    }
                    app.shared.broadcast(app.version_state());
                }
            }
        });
    }

    /// Installs the process launcher a `restartServer` command uses.
    pub fn set_restart_hook(&self, hook: Arc<dyn Fn() -> Result<(), String> + Send + Sync>) {
        if let Ok(mut slot) = self.restart_hook.lock() {
            *slot = Some(hook);
        }
    }

    /// Persists whether a restart waits for idle work.
    fn register_restart_section(self: &Arc<Self>) {
        struct Section {
            flag: Arc<std::sync::atomic::AtomicBool>,
        }
        impl StateSection for Section {
            fn snapshot(&self) -> Option<Value> {
                Some(Value::Bool(
                    self.flag.load(std::sync::atomic::Ordering::SeqCst),
                ))
            }
            fn restore(&self, value: &Value) {
                if let Some(value) = value.as_bool() {
                    self.flag.store(value, std::sync::atomic::Ordering::SeqCst);
                }
            }
        }
        self.shared.register_section(
            "restartWhenIdle",
            Arc::new(Section {
                flag: Arc::clone(&self.restart_when_idle),
            }),
        );
    }

    /// Persists the ACP children this process owns so its replacement can
    /// end any peer that outlives it.
    fn register_children_section(self: &Arc<Self>) {
        struct ChildrenSection {
            app: std::sync::Weak<App>,
        }
        impl StateSection for ChildrenSection {
            fn snapshot(&self) -> Option<Value> {
                let app = self.app.upgrade()?;
                let children: Vec<Value> = app
                    .capture_children()
                    .iter()
                    .map(crate::detached_run::RecordedChild::to_json)
                    .collect();
                Some(Value::Array(children))
            }

            fn restore(&self, value: &Value) {
                let Some(app) = self.app.upgrade() else {
                    return;
                };
                let Some(entries) = value.as_array() else {
                    return;
                };
                let children: Vec<crate::detached_run::RecordedChild> = entries
                    .iter()
                    .filter_map(|entry| crate::detached_run::RecordedChild::parse(Some(entry)))
                    .collect();
                if let Ok(mut slot) = app.restored_children.lock() {
                    *slot = children;
                };
            }
        }
        self.shared.register_section(
            "children",
            Arc::new(ChildrenSection {
                app: Arc::downgrade(self),
            }),
        );
    }

    /// The ACP peers this process still holds directly: a detached run belongs
    /// to its owner, which the replacement adopts.
    pub fn capture_children(&self) -> Vec<crate::detached_run::RecordedChild> {
        crate::flow_mode::capture_children(self.arc_self())
    }

    /// Ends the recorded peers the replaced process left behind.
    fn terminate_restored_children(&self) {
        let children = self
            .restored_children
            .lock()
            .map(|mut slot| std::mem::take(&mut *slot))
            .unwrap_or_default();
        if children.is_empty() {
            return;
        }
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                crate::detached_run::terminate_recorded_children(&children, 5_000).await;
            });
        }
    }

    /// Whether a restart is waiting for live work to finish.
    pub fn restart_waits_for_idle(&self) -> bool {
        self.restart_when_idle
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Keeps a restart request pending until no mode holds live work.
    pub fn hold_restart_until_idle(self: &Arc<Self>) {
        self.restart_when_idle
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let app = Arc::clone(self);
        tokio::spawn(async move {
            let mut timer = tokio::time::interval(std::time::Duration::from_millis(1_000));
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                timer.tick().await;
                if app.shared.busy_reason().is_none() {
                    let _ = app.begin_restart();
                    return;
                }
            }
        });
    }

    /// Replaces this process through its launcher, telling pages first.
    pub fn begin_restart(&self) -> Result<(), String> {
        self.restart_when_idle
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let hook = self.restart_hook.lock().ok().and_then(|slot| slot.clone());
        let Some(hook) = hook else {
            return Err("Restarting the server is not available.".to_string());
        };
        self.prepare_replacement();
        hook()
    }

    /// Whether harness reporting is configured for this process.
    pub fn feedback_enabled(&self) -> bool {
        self.config().feedback.is_some()
    }

    /// `POST /feedback`: refuses a method other than POST, then answers 503
    /// until harness reporting is configured.
    pub async fn feedback(
        &self,
        method: &Method,
        headers: &HeaderMap,
        url: &Url,
        flow_id: Option<&str>,
        body: axum::body::Body,
    ) -> axum::response::Response {
        if *method != Method::POST {
            return Replies::problem(
                headers,
                405,
                "This endpoint accepts POST only.",
                &[("Allow", "POST")],
            );
        }
        let Some(feedback) = self.config().feedback.clone() else {
            return Responses::disabled_reporting(headers);
        };
        if let Some(refusal) = request_refusal(headers, url, &self.shared.allowed_hostnames) {
            return crate::http::refusal_problem(
                headers,
                refusal,
                "Cross-origin feedback is refused.",
            );
        }
        let Some((raw, too_large)) = read_report(headers, body).await else {
            return Replies::problem(headers, 400, "The report could not be read.", &[]);
        };
        if too_large {
            return too_large_answer(headers);
        }
        let value: Value = match serde_json::from_str(&raw) {
            Ok(value) => value,
            Err(_) => return Replies::problem(headers, 400, "The report is not valid JSON.", &[]),
        };
        let key = match crate::idempotency::parse_idempotency_key(
            headers
                .get("idempotency-key")
                .and_then(|value| value.to_str().ok()),
        ) {
            Ok(key) => key,
            Err(error) => return Replies::problem(headers, error.status, &error.message, &[]),
        };
        let submission = match crate::feedback::parse_feedback_submission(&value) {
            Ok(submission) => submission,
            Err(error) => return Replies::problem(headers, error.status, &error.message, &[]),
        };
        let target = crate::gitea::GiteaTarget {
            base_url: feedback.base_url.clone(),
            project: feedback.repo.clone(),
            token: feedback.token.clone(),
        };
        let timeout_ms = feedback.timeout_ms;
        let outcome = self
            .idempotency
            .run("feedback", key.as_deref(), || async {
                crate::feedback::file_feedback_issue(&submission, &target, flow_id, timeout_ms)
                    .await
                    .map_err(|error| crate::feedback::RequestError {
                        status: error.status,
                        message: error.message,
                    })
            })
            .await;
        match outcome {
            Ok(filed) => {
                let href = filed
                    .pointer("/links/issue/href")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                Replies::json(headers, filed, 201, &[("Location", href.as_str())])
            }
            Err(error) => {
                if error.status == 502 || error.status == 504 {
                    self.shared.journal.write(
                        "server-error",
                        &format!("POST /feedback: {}", error.message),
                        flow_id,
                    );
                }
                Replies::problem(headers, error.status, &error.message, &[])
            }
        }
    }

    /// `POST /goal-proposals`: bounded JSON that writes one draft.
    pub async fn goal_proposals(
        &self,
        method: &Method,
        headers: &HeaderMap,
        url: &Url,
        flow_id: Option<&str>,
        body: axum::body::Body,
    ) -> axum::response::Response {
        if *method != Method::POST {
            return Replies::problem(
                headers,
                405,
                "This endpoint accepts POST only.",
                &[("Allow", "POST")],
            );
        }
        if let Some(refusal) = request_refusal(headers, url, &self.shared.allowed_hostnames) {
            return crate::http::refusal_problem(
                headers,
                refusal,
                "Cross-origin feedback is refused.",
            );
        }
        let Some((raw, too_large)) = read_report(headers, body).await else {
            return Replies::problem(headers, 400, "The report could not be read.", &[]);
        };
        if too_large {
            return too_large_answer(headers);
        }
        let value: Value = match serde_json::from_str(&raw) {
            Ok(value) => value,
            Err(_) => return Replies::problem(headers, 400, "The report is not valid JSON.", &[]),
        };
        let key = match crate::idempotency::parse_idempotency_key(
            headers
                .get("idempotency-key")
                .and_then(|value| value.to_str().ok()),
        ) {
            Ok(key) => key,
            Err(error) => return Replies::problem(headers, error.status, &error.message, &[]),
        };
        let submission = match crate::feedback::parse_goal_proposal_submission(&value) {
            Ok(submission) => submission,
            Err(error) => return Replies::problem(headers, error.status, &error.message, &[]),
        };
        let repo_dir = self.config().repo_dir.clone();
        let origin = url.origin().ascii_serialization();
        let outcome = self
            .idempotency
            .run("goal-proposal", key.as_deref(), || async {
                crate::goal_proposal::write_goal_proposal(
                    &submission,
                    &repo_dir,
                    None,
                    Some(&origin),
                )
                .await
            })
            .await;
        match outcome {
            Ok(proposal) => {
                // Every connected page sees the draft list the POST changed.
                let drafts: Vec<Value> = crate::goal_drafts::list_goal_drafts(&repo_dir)
                    .iter()
                    .map(crate::goal_drafts::GoalDraftSummary::to_json)
                    .collect();
                self.broadcast(json!({"type": "issuesDrafts", "drafts": drafts}));
                let href = proposal
                    .pointer("/links/draft/href")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                Replies::json(headers, proposal, 201, &[("Location", href.as_str())])
            }
            Err(error) if error.status >= 500 => {
                self.shared.journal.write(
                    "server-error",
                    &format!("POST /goal-proposals: {}", error.message),
                    flow_id,
                );
                Replies::problem(headers, 500, "An internal error occurred.", &[])
            }
            Err(error) => Replies::problem(headers, error.status, &error.message, &[]),
        }
    }
}

/// The largest body either mutating endpoint reads.
const MAX_REPORT_BYTES: usize = 64_000;

/// Reads one bounded body, or `None` when it could not be read.
async fn read_report(headers: &HeaderMap, body: axum::body::Body) -> Option<(String, bool)> {
    let declared = headers
        .get(axum::http::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(0.0);
    if declared.is_finite() && declared > MAX_REPORT_BYTES as f64 {
        return Some((String::new(), true));
    }
    let collected = axum::body::to_bytes(body, MAX_REPORT_BYTES + 1)
        .await
        .ok()?;
    let raw = std::str::from_utf8(&collected).ok()?.to_string();
    if crate::feedback::js_len(&raw) > MAX_REPORT_BYTES {
        return Some((raw, true));
    }
    Some((raw, false))
}

/// The 413 for a report larger than the bound.
fn too_large_answer(headers: &HeaderMap) -> axum::response::Response {
    Replies::problem(
        headers,
        413,
        &format!("The report is larger than {MAX_REPORT_BYTES} bytes."),
        &[],
    )
}

/// The reporting-disabled answer both mutating endpoints share.
struct Responses;

impl Responses {
    fn disabled_reporting(headers: &HeaderMap) -> axum::response::Response {
        Replies::problem(
            headers,
            503,
            "Harness reporting is disabled. Set DEVBOARD_GITEA_URL and GITEA_TOKEN to file issues.",
            &[],
        )
    }
}

/// The label the client shows for the served project: its path relative to
/// the user's home, or the absolute path outside it.
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

/// Every dispatcher command this dashboard answers today. The corpus test
/// fails when a corpus recording names a command this list lacks, and when a
/// listed command has no recording.
pub const IMPLEMENTED_COMMANDS: &[&str] = &[
    "answerGoalDraft",
    "ask",
    "closeAsk",
    "deleteProvider",
    "getProviders",
    "refreshProviders",
    "saveProvider",
    "prepareSkills",
    "deleteSkill",
    "createGoal",
    "reviseGoal",
    "setInstalledSkillEnabled",
    "setProviderEnabled",
    "deleteGoalDraft",
    "disableAgentTimer",
    "getAgent",
    "getAgentPrompt",
    "getAgents",
    "createFlowGoal",
    "cancelFlowGoal",
    "startFlowImplementation",
    "stopFlowImplementation",
    "retryFlowPr",
    "markFlowPrReady",
    "mergeFlowPr",
    "sendFlowSteering",
    "acceptFlowWidget",
    "refuseFlowWidget",
    "openFlowWidget",
    "closeFlowWidget",
    "sendFlowConversation",
    "sendFlowConclusion",
    "dismissFlowBlocker",
    "flowAnswer",
    "answerDiscover",
    "clearDiscoverRemote",
    "confirmGlossaryTerm",
    "discoverAgent",
    "discoverProject",
    "discoverRemote",
    "getDiscover",
    "rejectGlossaryTerm",
    "removeDiscoverRemote",
    "stopDiscover",
    "switchDiscoverRemote",
    "getGoal",
    "getGoalDraft",
    "getGoalDrafts",
    "answerIssues",
    "checkIssues",
    "closeIssue",
    "getInstalledSkills",
    "getComplexity",
    "getIssues",
    "getIssuesRun",
    "pauseIssues",
    "resumeIssues",
    "startIssues",
    "stopIssues",
    "getSkills",
    "getMcpTools",
    "getProject",
    "getVersion",
    "listRecords",
    "refreshAgent",
    "startLifecycle",
    "stopLifecycle",
    "pauseLifecycle",
    "resumeLifecycle",
    "startRun",
    "answer",
    "resetImplementation",
    "restartServer",
    "setAgentSettings",
    "startAgent",
    "stopAgent",
    "startGoalDraft",
    "stopGoalDraft",
];

/// Whether one command name is implemented.
pub fn is_implemented(command: &str) -> bool {
    IMPLEMENTED_COMMANDS.contains(&command)
}

/// Guards the `/goal-proposals` endpoint against a missing credential.
#[allow(dead_code)]
fn credential_presented(headers: &HeaderMap, cookie_name: &str) -> Option<String> {
    presented_credential(headers, cookie_name)
}
