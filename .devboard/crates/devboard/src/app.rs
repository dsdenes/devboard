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

use crate::command::Command;
use crate::config::Config;
use crate::http::{request_refusal, Replies};
use crate::journal::Journal;

tokio::task_local! {
    /// The request handle whose command this task is running. A fan-out frame
    /// reaches a request handle only from the command that produced it, so a
    /// live worker's activity never enters another action's reply and never
    /// holds that reply's answer window open.
    static REQUEST_ORIGIN: u64;
}

/// One connected client's handle.
#[derive(Clone)]
pub struct Conn {
    id: u64,
    outbox: crate::http::Outbox,
    /// True for the ephemeral handle one HTTP request uses. It carries no
    /// durable connection ownership across requests.
    request: bool,
}

impl Conn {
    pub fn new(outbox: crate::http::Outbox) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        Self {
            id: NEXT.fetch_add(1, Ordering::Relaxed),
            outbox,
            request: false,
        }
    }

    /// The handle one REST request answers through.
    pub fn new_request(outbox: crate::http::Outbox) -> Self {
        let mut conn = Self::new(outbox);
        conn.request = true;
        conn
    }

    pub fn id(&self) -> u64 {
        self.id
    }

    /// Whether this handle belongs to one HTTP request, not a socket.
    pub fn is_request(&self) -> bool {
        self.request
    }

    /// Sends one event; a closed socket drops it.
    pub fn send(&self, event: Value) {
        let _ = self.outbox.send(crate::jsjson::stringify(&event));
    }

    /// Sends one already-serialized payload, reporting whether its socket
    /// still accepts frames. A fan-out uses it to forget the handles whose
    /// receiver is gone instead of feeding them every later frame.
    pub fn send_payload(&self, payload: String) -> bool {
        self.outbox.send(payload).is_ok()
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
    /// The damaged-state detail a new client is owed, once.
    restore_error: Mutex<Option<String>>,
}

impl Shared {
    /// Every event a client can observe leaves after the state that produced
    /// it is on disk.
    pub fn broadcast(&self, event: Value) {
        self.persist(&event);
        let payload = crate::jsjson::stringify(&event);
        self.fan_out(&payload, None);
        if let Ok(hooks) = self.broadcast_hooks.lock() {
            for hook in hooks.iter() {
                hook();
            }
        }
    }

    /// Delivers one payload to every client the fan-out belongs to: a durable
    /// client always, a request handle only while the command running in that
    /// handle's own task is the one broadcasting. Unrelated traffic — a live
    /// worker's activity lines, the poll republishing a changed snapshot —
    /// belongs to no request, so it never reaches a reply in flight.
    fn fan_out(&self, payload: &str, except: Option<u64>) {
        let origin = REQUEST_ORIGIN.try_with(|id| *id).ok();
        if let Ok(clients) = self.clients.lock() {
            for conn in clients.values() {
                if Some(conn.id()) == except {
                    continue;
                }
                if conn.is_request() && Some(conn.id()) != origin {
                    continue;
                }
                let _ = conn.outbox.send(payload.to_string());
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
        self.fan_out(&payload, except);
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

    /// Ends the work every mode says a reset or creation preempts. The Issues
    /// worker is a long-lived repository service, not a run: creating a goal
    /// never stops it.
    pub fn abort_all_work(&self) {
        if let Ok(gates) = self.gates.lock() {
            for (name, gate) in gates.iter() {
                if name == "issues" {
                    continue;
                }
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
                if let Ok(mut slot) = self.restore_error.lock() {
                    *slot = Some(format!(
                        "Could not restore the saved dashboard state: {detail}"
                    ));
                }
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

    /// Writes the current state even when no event produced it, so a signal
    /// stop leaves a valid state file behind.
    pub fn flush_state(&self) {
        self.persist(&Value::Null);
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

/// One creation answer kept for an `Idempotency-Key`.
#[derive(Debug, Clone)]
pub struct CachedRest {
    pub status: u16,
    pub body: Value,
    pub extra: Vec<(String, String)>,
}

/// The dashboard application.
pub struct App {
    pub shared: Arc<Shared>,
    pub idempotency: crate::idempotency::IdempotencyStore,
    /// Every report this dashboard accepted, and the ones it is filing.
    pub reports: Arc<crate::reports::ReportStore>,
    /// Identifies this dashboard instance to the detached-run owners.
    pub instance: String,
    /// The version this process loaded at startup.
    pub running_version: Option<String>,
    /// The port this process serves on: the configured one, updated to the
    /// bound port when the listener resolves an ephemeral one.
    port: std::sync::atomic::AtomicU16,
    /// The version facts this process resolved at startup, so a `versionState`
    /// read answers without spawning git or reading a manifest. An install that
    /// lands beside this process records its version here.
    version_facts: Mutex<crate::version::VersionFacts>,
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
    /// The resource governor the Resources tab reads and writes.
    pub resources: Arc<crate::resources::Governor>,
    /// The dashboard's own handle, for modes that hold a shared reference.
    weak_self: std::sync::Weak<App>,
    /// Replaces this process; absent means the dashboard has no launcher.
    restart_hook: Mutex<Option<Arc<dyn Fn() -> Result<(), String> + Send + Sync>>>,
    source_refresher: Mutex<Option<crate::source_refresh::SourceRefresher>>,
    restart_when_idle: Arc<std::sync::atomic::AtomicBool>,
    /// True while one restart request is in flight.
    restarting: std::sync::atomic::AtomicBool,
    /// ACP children the previous process recorded for its replacement to end.
    restored_children: Mutex<Vec<crate::detached_run::RecordedChild>>,
    /// Creation answers replayed for one `Idempotency-Key`.
    rest_cache: Mutex<HashMap<(String, String, String), CachedRest>>,
    /// The retained output journal each live run's socket follows.
    pub run_output: Arc<crate::runs::RunHub>,
}

impl App {
    pub fn new(config: Config, journal: Journal) -> Arc<Self> {
        let port = config.port;
        let allowed_hostnames =
            crate::http::allowed_request_hostnames(&config.hostname, &config.allowed_hosts);
        let idempotency =
            crate::idempotency::IdempotencyStore::open(&config.state_dir, &config.repo_dir);
        let reports = Arc::new(crate::reports::ReportStore::open(
            &config.state_dir,
            &config.repo_dir,
        ));
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
            allowed_hostnames,
            state_path,
            sections: Mutex::new(Vec::new()),
            last_saved: Mutex::new(None),
            shutdown: tokio::sync::Notify::new(),
            gates: Mutex::new(Vec::new()),
            broadcast_hooks: Mutex::new(Vec::new()),
            persist_lock: Mutex::new(()),
            restore_error: Mutex::new(None),
        });
        // The MCP optimizer page reads one projection file even before its
        // first cycle. Publish the empty, successful projection once; a later
        // cycle replaces it with the forge state it read.
        let coach =
            crate::workers::mcp_optimizer::mcp_optimizer_directory(&config_state_dir(&shared));
        if !crate::workers::mcp_optimizer::projection_path(&coach).exists() {
            let _ = crate::workers::mcp_optimizer::write_projection(
                &coach,
                &crate::workers::mcp_optimizer::Projection {
                    state: "ok".to_string(),
                    at: Some(crate::journal::now_iso8601()),
                    error: None,
                    issues: Vec::new(),
                },
            );
        }
        let running_version = std::env::var("DEVBOARD_RUNNING_VERSION")
            .ok()
            .filter(|value| !value.is_empty())
            .or_else(|| {
                crate::version::read_harness_version(&crate::version::running_harness_dir())
            });
        // Resolved once here, so a polled `versionState` read never spawns git
        // or reads a manifest on the request path.
        let version_facts = crate::version::VersionFacts::resolve(&config_repo_dir(&shared));
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
        let resources = crate::resources::for_app(&config_state_dir(&shared));
        let app = Arc::new_cyclic(|weak| Self {
            weak_self: weak.clone(),
            shared,
            idempotency,
            reports,
            instance,
            running_version,
            port: std::sync::atomic::AtomicU16::new(port),
            version_facts: Mutex::new(version_facts),
            latest_version: Mutex::new(None),
            replacement_failure: Mutex::new(None),
            attempted_replacement: Mutex::new(None),
            updater: Mutex::new(None),
            providers,
            complexity,
            resources,
            restart_hook: Mutex::new(None),
            source_refresher: Mutex::new(None),
            restart_when_idle: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            restarting: std::sync::atomic::AtomicBool::new(false),
            restored_children: Mutex::new(Vec::new()),
            rest_cache: Mutex::new(HashMap::new()),
            run_output: Arc::new(crate::runs::RunHub::new()),
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
        if app.restart_waits_for_idle() {
            // A restart was waiting for idle work when the previous process
            // ended; resume the wait instead of dropping the request.
            app.restart_when_idle
                .store(false, std::sync::atomic::Ordering::SeqCst);
            app.hold_restart_until_idle();
        }
        app.terminate_restored_children();
        app.start_lease_refresh();
        app.start_provider_refresh();
        app
    }

    /// Refreshes provider usage on the dashboard's own cadence. The Start and
    /// read paths only use the cached report, so this task is the one place a
    /// stale report is replaced; a read that finds one wakes it immediately.
    /// It makes no provider call while no client is connected.
    fn start_provider_refresh(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        let wake = self.providers.refresh_wake();
        tokio::spawn(async move {
            let mut timer = tokio::time::interval(std::time::Duration::from_millis(
                crate::providers::USAGE_TTL_MS,
            ));
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            // `interval` fires immediately; the first push belongs one period
            // later, so a fresh connection never receives an unsolicited
            // providersState before its own replay and first command.
            timer.tick().await;
            loop {
                let demanded = tokio::select! {
                    _ = timer.tick() => false,
                    _ = wake.notified() => true,
                };
                let Some(app) = weak.upgrade() else {
                    break;
                };
                // A read asked for this one; only the periodic tick waits for
                // a connected client.
                if !demanded && !app.shared.has_clients() {
                    continue;
                }
                app.providers.background_refresh().await;
                app.shared.send_all(app.providers.state_frame(), None);
            }
        });
    }

    pub fn config(&self) -> &Config {
        &self.shared.config
    }

    /// The port this process serves on. A configured port is known before the
    /// listener is bound; an ephemeral one (`--port 0`) is resolved by the bind
    /// and stored here, so a replacement never inherits the placeholder.
    pub fn port(&self) -> u16 {
        self.port.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Records the listener's port.
    pub fn set_port(&self, port: u16) {
        self.port.store(port, std::sync::atomic::Ordering::SeqCst);
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

    /// Journals every kernel kill the slice records and routes deferral
    /// reports into the dashboard journal. Runs only while serving.
    pub fn start_resource_watcher(self: &Arc<Self>) {
        if !self.resources.slice_enabled() {
            return;
        }
        {
            let weak = Arc::downgrade(self);
            self.resources.set_journal_hook(Arc::new(move |kind, text| {
                if let Some(app) = weak.upgrade() {
                    app.shared.journal.write(kind, text, None);
                }
            }));
        }
        let app = Arc::clone(self);
        tokio::spawn(async move {
            let mut timer = tokio::time::interval(std::time::Duration::from_secs(2));
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                timer.tick().await;
                // `collect_kills` records the kill and calls the journal hook.
                let _ = app.resources.collect_kills();
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

    /// The frames a client owes on connect, before its own replies. A damaged
    /// state file is reported once, before any restored state.
    pub async fn open(&self, conn: &Conn) {
        let damaged = self
            .shared
            .restore_error
            .lock()
            .ok()
            .and_then(|mut slot| slot.take());
        if let Some(message) = damaged {
            conn.send(json!({"type": "error", "message": message}));
        }
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
    }

    /// Applies one client command.
    pub async fn command(&self, conn: &Conn, command: Command) {
        if let Err(error) = self.dispatch(conn, command).await {
            conn.send(json!({"type": "error", "message": error}));
        }
    }

    /// Applies one command for an HTTP request and returns the frames it
    /// wrote before the handler returned.
    pub async fn dispatch_captured(&self, command: Command) -> Vec<Value> {
        let (outbox, mut incoming) = tokio::sync::mpsc::unbounded_channel::<String>();
        let conn = Conn::new_request(outbox);
        let id = conn.id();
        // The request handle joins the clients for the duration of the
        // handler, so a mutation that answers through the shared broadcast
        // still reaches it and `has_clients` sees the page that asked. The
        // fan-out itself is attributed to the task below: only the command
        // running in this request's own task can answer it.
        self.register(conn.clone()).await;
        let app = self.arc_self();
        let mut task = tokio::spawn(REQUEST_ORIGIN.scope(id, async move {
            if let Err(error) = app.dispatch(&conn, command).await {
                conn.send(json!({"type": "error", "message": error}));
            }
        }));
        // A long action (a Start's preflight, a run's turn) answers its first
        // frames before it finishes. The request returns those frames and the
        // page polls the resource for the rest; the handler keeps running. A
        // handler that has not answered yet gets the full window, so a busy
        // dashboard cannot truncate its first refusal.
        let hard = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut quiet: Option<tokio::time::Instant> = None;
        let mut frames = Vec::new();
        loop {
            let limit = quiet.map(|quiet| quiet.min(hard)).unwrap_or(hard);
            let remaining = limit.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            tokio::select! {
                _ = &mut task => {
                    while let Ok(text) = incoming.try_recv() {
                        if let Ok(frame) = serde_json::from_str::<Value>(&text) {
                            frames.push(frame);
                        }
                    }
                    break;
                }
                received = incoming.recv() => {
                    match received {
                        Some(text) => {
                            if let Ok(frame) = serde_json::from_str::<Value>(&text) {
                                frames.push(frame);
                            }
                            quiet = Some(
                                tokio::time::Instant::now()
                                    + std::time::Duration::from_millis(250),
                            );
                        }
                        None => break,
                    }
                }
                _ = tokio::time::sleep(remaining) => break,
            }
        }
        while let Ok(text) = incoming.try_recv() {
            if let Ok(frame) = serde_json::from_str::<Value>(&text) {
                frames.push(frame);
            }
        }
        drop(incoming);
        self.unregister(id).await;
        self.complexity.unsubscribe(id);
        frames
    }

    /// One creation answer already produced for this key.
    pub fn rest_cached(&self, method: &Method, path: &str, key: &str) -> Option<CachedRest> {
        self.rest_cache.lock().ok().and_then(|cache| {
            cache
                .get(&(
                    method.as_str().to_string(),
                    path.to_string(),
                    key.to_string(),
                ))
                .cloned()
        })
    }

    /// Remembers one creation answer under its idempotency key.
    pub fn remember_rest(&self, method: &Method, path: &str, key: &str, answer: CachedRest) {
        if let Ok(mut cache) = self.rest_cache.lock() {
            cache.insert(
                (
                    method.as_str().to_string(),
                    path.to_string(),
                    key.to_string(),
                ),
                answer,
            );
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
                let app = self.arc_self();
                crate::goal_authoring::replay(&app, conn);
                crate::goal_run::replay(&app, conn);
                Ok(())
            }
            Command::ListRecords => match crate::records::read_records(&self.config().adrs_dir) {
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
                if self.restarting.load(std::sync::atomic::Ordering::SeqCst) {
                    conn.send(json!({"type": "error", "message": "A server restart is already in progress."}));
                    return Ok(());
                }
                let when_idle = when_idle.as_ref().and_then(Value::as_bool).unwrap_or(false);
                if when_idle && self.shared.busy_reason().is_some() {
                    self.arc_self().hold_restart_until_idle();
                    return Ok(());
                }
                // A failure is reported to every client through
                // `replacement_failed`; the requester is one of them.
                let _ = self.arc_self().begin_restart();
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
            Command::GetResources => {
                conn.send(self.resources.state_event());
                Ok(())
            }
            Command::SetResources {
                max_agent_peers,
                memory_high_mb,
                memory_max_mb,
                memory_reserve_mb,
            } => {
                match self.resources.apply_update(
                    max_agent_peers.as_ref(),
                    memory_high_mb.as_ref(),
                    memory_max_mb.as_ref(),
                    memory_reserve_mb.as_ref(),
                ) {
                    Ok(_) => self.broadcast(self.resources.state_event()),
                    Err(message) => conn.send(json!({"type": "error", "message": message})),
                }
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
                if crate::goal_drafts::handle(conn, &self.config().repo_dir, &other).await {
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
        let mut state = {
            let facts = self
                .version_facts
                .lock()
                .map(|facts| facts.clone())
                .unwrap_or_default();
            crate::version::server_version_from(&facts, self.running_version.clone(), latest)
        };
        if let Ok(failure) = self.replacement_failure.lock() {
            if let Some(error) = failure.clone() {
                state.replacement = Some(crate::version::ReplacementFailure {
                    running: state.running.clone(),
                    installed: state.installed.clone(),
                    error,
                });
            }
        }
        let mut value = state.to_json(self.feedback_enabled());
        if self.restarting.load(std::sync::atomic::Ordering::SeqCst) {
            if let Some(object) = value.as_object_mut() {
                object.insert("restarting".to_string(), Value::Bool(true));
            }
        }
        value
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

    /// Records a version an install put beside this process, so a read names it
    /// as what a restart would load before the replacement starts.
    pub fn note_installed_version(&self, version: &str) {
        if let Ok(mut facts) = self.version_facts.lock() {
            facts.installed = Some(version.to_string());
        }
    }

    /// Journals one failure with its scope.
    pub fn journal_error(&self, kind: &str, text: &str) {
        self.shared.journal.write(kind, text, None);
        eprintln!("{text}");
    }

    /// Syncs the host's managed copies from the installed harness.
    pub fn sync_host_copies(&self) -> anyhow::Result<()> {
        let report = crate::cli_install::install(Some(&self.config().repo_dir), true)?;
        if report.agents.as_str() == "drift" {
            self.shared
                .journal
                .write("update", "AGENTS.md differs from the template", None);
        }
        for line in &report.drift {
            self.shared.journal.write(
                "update",
                &format!("{line} is tracked by the host; left unchanged"),
                None,
            );
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
        // The artifact is beside this process now, so it is what a restart
        // would load even if the replacement never starts; a read answers from
        // these facts, and the failure frame names both versions.
        self.note_installed_version(version);
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
            let settings = crate::relaunch::RelaunchSettings::from_app(&app);
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
                    app.replacement_failed(&error);
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
        if !self
            .restart_when_idle
            .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            self.shared.broadcast(json!({"type": "upgradePending"}));
        }
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
    pub fn begin_restart(self: &Arc<Self>) -> Result<(), String> {
        if self
            .restarting
            .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            return Err("A server restart is already in progress.".to_string());
        }
        self.restart_when_idle
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let hook = self.restart_hook.lock().ok().and_then(|slot| slot.clone());
        let Some(hook) = hook else {
            self.restarting
                .store(false, std::sync::atomic::Ordering::SeqCst);
            return Err("Restarting the server is not available.".to_string());
        };
        self.prepare_replacement();
        match hook() {
            Ok(()) => Ok(()),
            Err(message) => {
                self.replacement_failed(&message);
                Err(message)
            }
        }
    }

    /// Replaces this process through a confirmed handoff.
    ///
    /// The CLI's restart hook uses this instead of an immediate exit: the
    /// replacement announces readiness while this process still holds both the
    /// dashboard port and the host guard, so the handoff never leaves the host
    /// with two dashboards. A failed replacement keeps this process serving
    /// and reports through the ordinary error path.
    pub fn restart_confirmed(self: &Arc<Self>) -> Result<(), String> {
        let app = self.clone();
        tokio::spawn(async move {
            let settings = crate::relaunch::RelaunchSettings::from_app(&app);
            let ready_file = app
                .config()
                .state_dir
                .join("replacement")
                .join(format!("ready-{}.json", std::process::id()));
            match crate::relaunch::relaunch_confirmed(&settings, &ready_file, 15_000, None).await {
                Ok(()) => {
                    app.shared.shutdown.notify_waiters();
                    std::process::exit(0);
                }
                Err(error) => app.replacement_failed(&error),
            }
        });
        Ok(())
    }

    /// The one failure path a restart and an automatic replacement share: the
    /// handoff files go, the old process keeps serving, and every page is told
    /// both versions and the failure.
    fn replacement_failed(self: &Arc<Self>, error: &str) {
        let config = self.config();
        crate::detached_run::end_detached_handoff(
            &config.state_dir,
            &config.repo_dir,
            Some(&self.instance),
        );
        crate::goal_drafts::remove_goal_draft_handoff(&config.state_dir, &config.repo_dir);
        if let Ok(mut failure) = self.replacement_failure.lock() {
            *failure = Some(error.to_string());
        }
        self.restart_when_idle
            .store(false, std::sync::atomic::Ordering::SeqCst);
        self.restarting
            .store(false, std::sync::atomic::Ordering::SeqCst);
        self.shared.broadcast(self.version_state());
        self.shared
            .broadcast(json!({"type": "error", "message": error}));
    }

    /// Whether harness reporting is configured for this process.
    pub fn feedback_enabled(&self) -> bool {
        self.config().feedback.is_some()
    }

    /// `POST /reports`: refuses a method other than POST, then answers 503
    /// until harness reporting is configured.
    ///
    /// An accepted report answers `202` with the record this dashboard owns and
    /// files the issue on its own runtime, so the forge's own latency never
    /// holds the operator's action open.
    pub async fn reports(
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
                "Cross-origin reports are refused.",
            );
        }
        let raw = match read_report(headers, body).await {
            Ok(raw) => raw,
            Err(ReportRefusal::TooLarge) => return too_large_answer(headers),
            Err(ReportRefusal::Unreadable) => {
                return Replies::problem(headers, 400, "The report could not be read.", &[])
            }
        };
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
        let title = crate::feedback::feedback_title(&submission);
        let origin = url.origin().ascii_serialization();
        let id = match self.reports.claim(key.as_deref(), &title).await {
            crate::reports::ReportClaim::Replay(view) => {
                // Only a filed record answers as a settled resource; one still
                // filing keeps the 202 its first request earned.
                let status = if view["status"] == "FILED" { 200 } else { 202 };
                let view = report_document(view, &origin, timeout_ms);
                let href = view["links"]["report"]["href"]
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                return Replies::json(headers, view, status, &[("Location", href.as_str())]);
            }
            crate::reports::ReportClaim::Start(id) => id,
        };
        // The delivery is the dashboard's own background work: the forge is not
        // bound by this endpoint's budget, so the operator's action answers from
        // the record and `GET /reports/<id>` carries the issue once it exists.
        let app = self.arc_self();
        let owned_flow = flow_id.map(str::to_string);
        tokio::spawn(async move {
            let outcome = crate::feedback::file_feedback_issue(
                &submission,
                &target,
                owned_flow.as_deref(),
                timeout_ms,
                &crate::forge::real_sleep(),
            )
            .await;
            match outcome {
                Ok(filed) => {
                    let href = filed
                        .pointer("/links/issue/href")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    app.reports.settle(id, Ok(href)).await;
                }
                Err(error) => {
                    let refusal = crate::feedback::RequestError::delivery(error);
                    let detail = format!("POST /reports: {}", refusal.journal_detail());
                    if refusal.transient {
                        // The forge answered nothing: an unreachable or slow
                        // upstream delays a report, so it is recorded as
                        // activity and never as a server error.
                        app.shared.journal.write(
                            "activity",
                            &format!("feedback delivery delayed: {detail}"),
                            owned_flow.as_deref(),
                        );
                    } else if refusal.rejected_credential {
                        // The forge answered and refused the dashboard's own
                        // credential: reporting is misconfigured until the
                        // operator refreshes it, so this is a configuration
                        // failure the client names and never a server error the
                        // watchdog files.
                        app.shared.journal.write(
                            "activity",
                            &format!("feedback delivery rejected: {detail}"),
                            owned_flow.as_deref(),
                        );
                    } else if refusal.status == 502 || refusal.status == 504 {
                        app.shared
                            .journal
                            .write("server-error", &detail, owned_flow.as_deref());
                    }
                    app.reports.settle(id, Err(refusal.message)).await;
                }
            }
        });
        let view = self
            .reports
            .view(id)
            .unwrap_or_else(|| serde_json::json!({"id": id, "status": "FILING"}));
        let view = report_document(view, &origin, timeout_ms);
        let href = view["links"]["report"]["href"]
            .as_str()
            .unwrap_or("")
            .to_string();
        Replies::json(headers, view, 202, &[("Location", href.as_str())])
    }

    /// `GET /reports/<id>`: one report this dashboard accepted.
    pub fn report_record(
        &self,
        method: &Method,
        headers: &HeaderMap,
        url: &Url,
        id: &str,
    ) -> axum::response::Response {
        if *method != Method::GET {
            return Replies::problem(
                headers,
                405,
                "This endpoint accepts GET only.",
                &[("Allow", "GET")],
            );
        }
        let timeout_ms = self
            .config()
            .feedback
            .as_ref()
            .map(|feedback| feedback.timeout_ms)
            .unwrap_or(60_000);
        let record = id.parse::<u64>().ok().and_then(|id| self.reports.view(id));
        match record {
            Some(view) => {
                let origin = url.origin().ascii_serialization();
                let view = report_document(view, &origin, timeout_ms);
                Replies::json(headers, view, 200, &[])
            }
            None => Replies::problem(headers, 404, "The requested report was not found.", &[]),
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
                "Cross-origin reports are refused.",
            );
        }
        let raw = match read_report(headers, body).await {
            Ok(raw) => raw,
            Err(ReportRefusal::TooLarge) => return too_large_answer(headers),
            Err(ReportRefusal::Unreadable) => {
                return Replies::problem(headers, 400, "The report could not be read.", &[])
            }
        };
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
                crate::goal_proposal::write_goal_proposal(&submission, &repo_dir, Some(&origin))
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

/// Why one report body could not be read.
enum ReportRefusal {
    /// The body exceeds `MAX_REPORT_BYTES`, declared or as read.
    TooLarge,
    /// The body could not be read at all, or is not UTF-8.
    Unreadable,
}

/// Reads one bounded body, or names why it was refused.
async fn read_report(headers: &HeaderMap, body: axum::body::Body) -> Result<String, ReportRefusal> {
    let declared = headers
        .get(axum::http::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(0.0);
    if declared.is_finite() && declared > MAX_REPORT_BYTES as f64 {
        return Err(ReportRefusal::TooLarge);
    }
    let collected = match axum::body::to_bytes(body, MAX_REPORT_BYTES + 1).await {
        Ok(collected) => collected,
        // The one-byte-over bound refuses an oversized chunked body here; every
        // other read failure, such as a dropped connection, is not a size answer.
        Err(error) => {
            return Err(
                if error.into_inner().is::<http_body_util::LengthLimitError>() {
                    ReportRefusal::TooLarge
                } else {
                    ReportRefusal::Unreadable
                },
            )
        }
    };
    let raw = std::str::from_utf8(&collected)
        .map_err(|_| ReportRefusal::Unreadable)?
        .to_string();
    if crate::feedback::js_len(&raw) > MAX_REPORT_BYTES {
        return Err(ReportRefusal::TooLarge);
    }
    Ok(raw)
}

/// One report record as the HTTP surface serves it: the record links itself with
/// the absolute URL its `Location` names, and states the delivery bound the
/// dashboard honors.
fn report_document(mut view: Value, origin: &str, timeout_ms: u64) -> Value {
    let id = view.get("id").and_then(Value::as_u64).unwrap_or(0);
    view["delivery_timeout_ms"] = serde_json::json!(timeout_ms);
    if !view["links"].is_object() {
        view["links"] = serde_json::json!({});
    }
    view["links"]["report"] = serde_json::json!({"href": format!("{origin}/reports/{id}")});
    view
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

/// Ends everything a stopping dashboard owns: Discover staging and its peer,
/// the ACP peers it holds directly, and every harness descendant (a worker, a
/// stub, or an `omp acp` peer), then persists the state file. A replacement
/// never calls this; it writes the handoff and leaves the work to its
/// successor.
pub async fn graceful_shutdown(app: &Arc<App>) {
    crate::discover_mode::shutdown(app);
    let children = app.capture_children();
    crate::detached_run::terminate_recorded_children(&children, 5_000).await;
    crate::supervision::terminate_harness_descendants(std::process::id(), 5_000).await;
    app.shared.flush_state();
}
