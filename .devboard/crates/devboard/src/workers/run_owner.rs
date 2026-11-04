//! The detached owner of one ACP run; the entry point of its own process.
//!
//! It spawns the real peer, appends activity and assistant text, publishes its
//! question and status, and consumes the dashboard's answer, stop, pause, and
//! resume commands. It outlives a dashboard replacement and ends only when the
//! run ends or no supervisor is left after a handoff window.

use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};

use crate::acp::{AcpConnection, AcpConnectionOptions, AcpEvent, PermissionPolicy};
use crate::detached_run::{
    append_detached_run_activity, append_detached_run_text, detached_run_control_directory,
    detached_run_directory, detached_run_prompt_path, read_detached_handoff, read_detached_lease,
    read_detached_run_state, recorded_child_alive, self_child, take_detached_run_commands,
    write_detached_run_state, DetachedRunActivity, DetachedRunCommand, DetachedRunState,
    DetachedRunStatus, DetachedTurnStatus, RecordedChild, DETACHED_HANDOFF_GRACE_MS,
    DETACHED_RUN_INTERRUPTED,
};
use crate::workers::WorkerInvocation;

/// How often the owner consumes commands and checks its supervisor.
const OWNER_CHECK_MS: u64 = 100;
/// How long the owner waits for the peer to exit before it forces it.
const PEER_CLOSE_GRACE_MS: u64 = 1_500;
/// How long the owner waits for the dashboard's starting state to appear.
const LAUNCH_WAIT_MS: u64 = 3_000;

/// Runs one detached run owner until its run ends.
pub async fn run(invocation: &WorkerInvocation) -> Result<()> {
    let repo_dir = invocation.repo_dir.clone();
    let state_dir = invocation.state_dir.clone();
    let Some(kind) = invocation.option("kind").map(str::to_string) else {
        anyhow::bail!("run owner: --repo, --state-dir, --kind, and --key are required.");
    };
    let Some(key) = invocation.option("key").map(str::to_string) else {
        anyhow::bail!("run owner: --repo, --state-dir, --kind, and --key are required.");
    };
    let directory = detached_run_directory(&state_dir, &repo_dir, &kind, &key);
    let generation = invocation.option("generation").map(str::to_string);
    let command = invocation
        .option("command")
        .unwrap_or("omp acp")
        .to_string();
    let cwd = invocation
        .option("cwd")
        .map(PathBuf::from)
        .unwrap_or_else(|| repo_dir.clone());
    let permission = match invocation.option("permission") {
        Some("read-only") => PermissionPolicy::ReadOnly,
        Some("deny") => PermissionPolicy::Deny,
        _ => PermissionPolicy::Allow,
    };
    let multi = invocation.rest.iter().any(|argument| argument == "--multi");
    let harness_version = invocation.option("harness-version").map(str::to_string);

    // The dashboard writes the starting state before it spawns this process.
    let deadline = Instant::now() + Duration::from_millis(LAUNCH_WAIT_MS);
    let mut stored = read_detached_run_state(&directory);
    loop {
        let acceptable = stored.as_ref().is_some_and(|state| {
            state.status == DetachedRunStatus::Starting
                && generation
                    .as_deref()
                    .is_none_or(|wanted| state.generation == wanted)
        });
        if acceptable || Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
        stored = read_detached_run_state(&directory);
    }
    let Some(stored) = stored else {
        return Ok(());
    };
    if stored.status != DetachedRunStatus::Starting {
        return Ok(());
    }
    if generation
        .as_deref()
        .is_some_and(|wanted| stored.generation != wanted)
    {
        return Ok(());
    }

    let prompt = std::fs::read_to_string(detached_run_prompt_path(&directory)).unwrap_or_default();
    let _ = std::fs::remove_file(detached_run_prompt_path(&directory));

    let mut owner = Owner {
        directory: directory.clone(),
        repo_dir: repo_dir.clone(),
        state_dir: state_dir.clone(),
        control: detached_run_control_directory(&directory),
        state: stored,
        owner: self_child(&repo_dir),
        launcher_pid: None,
        peer: None,
        peer_child: None,
        first_stderr: String::new(),
        handoff_deadline: None,
        paused: false,
        done: false,
        turn: None,
    };
    owner.launcher_pid = owner
        .state
        .launcher_pid
        .or_else(|| owner.state.owner.as_ref().map(|owner| owner.pid));
    owner.state.owner = Some(owner.owner.clone());
    if owner.state.harness_version.is_none() {
        owner.state.harness_version = harness_version;
    }
    owner.state.updated_at = crate::journal::now_iso8601();
    owner.persist();

    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .context("listening for SIGTERM")?;
    #[cfg(unix)]
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
        .context("listening for SIGINT")?;

    let (peer, mut events) = match connect_peer(&owner, &command, &cwd, permission).await {
        Ok(connected) => connected,
        Err(message) => {
            owner.finish(DetachedRunStatus::Failed, Some(message)).await;
            return Ok(());
        }
    };
    owner.peer_child = peer.pid().map(|pid| RecordedChild {
        pid,
        argv: peer.argv(),
        cwd: crate::detached_run::canonical_process_path(&repo_dir)
            .display()
            .to_string(),
    });
    owner.peer = Some(Arc::clone(&peer));
    owner.state.status = DetachedRunStatus::Running;
    owner.persist();

    // The peer queues every assistant chunk before it answers the prompt, so
    // draining the event stream as it arrives journals a turn's answer while
    // it is still streaming.
    {
        let runner = Arc::clone(&peer);
        owner.start_turn(async move { runner.run(&prompt).await });
    }

    let mut ticker = tokio::time::interval(Duration::from_millis(OWNER_CHECK_MS));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = ticker.tick() => {
                if owner.process_commands().await {
                    return Ok(());
                }
                if !owner.check_supervisor() {
                    owner
                        .finish(
                            DetachedRunStatus::Failed,
                            Some(DETACHED_RUN_INTERRUPTED.to_string()),
                        )
                        .await;
                    return Ok(());
                }
                if multi
                    && owner.peer.as_ref().is_some_and(|peer| {
                        peer.closed()
                            || peer
                                .pid()
                                .is_none_or(|pid| !crate::supervision::live_process(pid))
                    })
                {
                    owner
                        .finish(
                            DetachedRunStatus::Failed,
                            Some("The ask agent exited.".to_string()),
                        )
                        .await;
                    return Ok(());
                }
            }
            Some(event) = events.recv() => {
                owner.apply_event(event);
            }
            _ = terminate.recv() => {
                owner
                    .finish(
                        DetachedRunStatus::Failed,
                        Some(DETACHED_RUN_INTERRUPTED.to_string()),
                    )
                    .await;
                return Ok(());
            }
            _ = interrupt.recv() => {
                owner
                    .finish(
                        DetachedRunStatus::Failed,
                        Some(DETACHED_RUN_INTERRUPTED.to_string()),
                    )
                    .await;
                return Ok(());
            }
        }
        if owner
            .turn
            .as_ref()
            .is_some_and(|handle| handle.is_finished())
        {
            // The peer queues every chunk it streamed before it answers the
            // prompt, so journal them before the turn's outcome becomes
            // visible to a dashboard.
            while let Ok(event) = events.try_recv() {
                owner.apply_event(event);
            }
            let handle = owner.turn.take().expect("a finished turn");
            let result = handle.await;
            if owner.handle_turn(Some(result)).await {
                return Ok(());
            }
        }
    }
}

/// One run's live owner: the peer, its state, and the supervisor it answers.
struct Owner {
    directory: PathBuf,
    repo_dir: PathBuf,
    state_dir: PathBuf,
    control: PathBuf,
    state: DetachedRunState,
    owner: RecordedChild,
    launcher_pid: Option<u32>,
    peer: Option<Arc<AcpConnection>>,
    peer_child: Option<RecordedChild>,
    first_stderr: String,
    handoff_deadline: Option<i64>,
    paused: bool,
    done: bool,
    turn: Option<tokio::task::JoinHandle<crate::acp::AcpResult<serde_json::Value>>>,
}

impl Owner {
    fn persist(&mut self) {
        if self.done {
            return;
        }
        let Some(current) = read_detached_run_state(&self.directory) else {
            std::process::exit(0);
        };
        if current.generation != self.state.generation {
            std::process::exit(0);
        }
        self.state.owner = Some(self.owner.clone());
        self.state.peer = self.peer_child.clone();
        self.state.updated_at = crate::journal::now_iso8601();
        let _ = write_detached_run_state(&self.directory, &self.state);
    }

    fn start_turn(
        &mut self,
        future: impl Future<Output = crate::acp::AcpResult<serde_json::Value>> + Send + 'static,
    ) {
        if self.turn.is_some() {
            return;
        }
        self.turn = Some(tokio::spawn(future));
    }

    /// Applies one finished turn. Returns true when the owner ended.
    async fn handle_turn(
        &mut self,
        result: Option<Result<crate::acp::AcpResult<serde_json::Value>, tokio::task::JoinError>>,
    ) -> bool {
        let Some(result) = result else {
            return false;
        };
        if self.done {
            return true;
        }
        let multi = self.state.multi;
        match result {
            Ok(Ok(_)) => {
                if !multi {
                    self.finish(DetachedRunStatus::Succeeded, None).await;
                    return true;
                }
                if self.state.turn_seq.unwrap_or(0) <= 1 {
                    self.state.turn_seq = Some(1);
                }
                self.state.turn_status = Some(DetachedTurnStatus::Succeeded);
                self.state.turn_error = None;
                self.persist();
                false
            }
            Ok(Err(error)) => {
                let detail = if !error.message.is_empty() {
                    error.message
                } else {
                    self.failure_detail()
                };
                if !multi {
                    self.finish(DetachedRunStatus::Failed, Some(detail)).await;
                    return true;
                }
                if self.state.turn_seq.unwrap_or(0) <= 1 {
                    self.state.turn_seq = Some(1);
                }
                self.state.turn_status = Some(DetachedTurnStatus::Failed);
                self.state.turn_error = Some(detail.clone());
                let usable = self.peer.as_ref().is_some_and(|peer| {
                    peer.has_session()
                        && !peer.closed()
                        && peer.pid().is_some_and(crate::supervision::live_process)
                });
                if !usable {
                    self.finish(DetachedRunStatus::Failed, Some(detail)).await;
                    return true;
                }
                self.persist();
                false
            }
            Err(_) => {
                let detail = self.failure_detail();
                if !multi {
                    self.finish(DetachedRunStatus::Failed, Some(detail)).await;
                    return true;
                }
                if self.state.turn_seq.unwrap_or(0) <= 1 {
                    self.state.turn_seq = Some(1);
                }
                self.state.turn_status = Some(DetachedTurnStatus::Failed);
                self.state.turn_error = Some(detail.clone());
                self.persist();
                false
            }
        }
    }

    fn apply_event(&mut self, event: AcpEvent) {
        if self.done {
            return;
        }
        match event {
            AcpEvent::Activity(entry) => {
                append_detached_run_activity(
                    &self.directory,
                    &DetachedRunActivity {
                        text: entry.text,
                        append: entry.append,
                    },
                );
                if self.state.status != DetachedRunStatus::Running {
                    self.state.status = DetachedRunStatus::Running;
                    self.persist();
                }
            }
            AcpEvent::Text(text) => {
                append_detached_run_text(&self.directory, &text);
            }
            AcpEvent::Question(question) => {
                self.state.question = Some(question);
                self.persist();
            }
            AcpEvent::Stderr(text) => {
                if self.first_stderr.is_empty() {
                    if let Some(line) = text
                        .split('\n')
                        .map(str::trim)
                        .find(|line| !line.is_empty())
                    {
                        self.first_stderr = line.to_string();
                    }
                }
            }
            AcpEvent::SessionUpdate => {}
        }
    }

    /// Consumes every pending instruction in name order. Returns true when
    /// the owner ended.
    async fn process_commands(&mut self) -> bool {
        for command in take_detached_run_commands(&self.control) {
            if self.done {
                return true;
            }
            match command {
                DetachedRunCommand::Prompt { seq, text } => {
                    if !self.state.multi || self.peer.is_none() {
                        continue;
                    }
                    self.state.turn_seq = Some(seq);
                    self.state.turn_status = Some(DetachedTurnStatus::Running);
                    self.state.turn_error = None;
                    self.persist();
                    let Some(peer) = self.peer.clone() else {
                        continue;
                    };
                    self.start_turn(async move { peer.prompt(&text).await });
                }
                DetachedRunCommand::Answer { id, value } => {
                    let Some(peer) = self.peer.clone() else {
                        continue;
                    };
                    if peer.answer(&id, &value).await {
                        self.state.question = None;
                        self.persist();
                    }
                }
                DetachedRunCommand::Stop => {
                    self.finish(DetachedRunStatus::Stopped, None).await;
                    return true;
                }
                DetachedRunCommand::Pause => {
                    self.paused = true;
                    if let Some(peer) = &self.peer {
                        peer.pause();
                    }
                }
                DetachedRunCommand::Resume => {
                    self.paused = false;
                    if let Some(peer) = &self.peer {
                        peer.resume();
                    }
                }
            }
        }
        let _ = self.paused;
        false
    }

    /// Keeps the peer alive across a dashboard replacement. The process that
    /// started this run supervises it for as long as it lives; several
    /// dashboards can serve one repository and share its lease, and the one
    /// that holds it did not start this run. Once that process exits, a lease
    /// from its replacement and a handoff marker decide the run.
    fn check_supervisor(&mut self) -> bool {
        let lease = read_detached_lease(&self.state_dir, &self.repo_dir);
        if let Some(launcher) = self
            .launcher_pid
            .filter(|pid| crate::supervision::live_process(*pid))
        {
            // A successor dashboard in this same process takes the lease and
            // adopts the run without a handoff.
            if let Some(lease) = &lease {
                if lease.pid == launcher && lease.instance != self.state.instance {
                    self.state.instance = lease.instance.clone();
                    self.persist();
                }
            }
            self.handoff_deadline = None;
            return true;
        }
        if let Some(lease) = lease.filter(|lease| crate::supervision::live_process(lease.pid)) {
            if lease.instance == self.state.instance {
                self.handoff_deadline = None;
                return true;
            }
            // A different dashboard instance holds the lease. It may adopt
            // this run only when the previous process wrote the replacement's
            // handoff.
            if let Some(handoff) = read_detached_handoff(&self.state_dir, &self.repo_dir) {
                let deadline = *self
                    .handoff_deadline
                    .get_or_insert(handoff.at + DETACHED_HANDOFF_GRACE_MS);
                if now_millis() < deadline {
                    return true;
                }
                self.state.instance = lease.instance.clone();
                self.persist();
                self.handoff_deadline = None;
                return true;
            }
            return false;
        }
        if let Some(handoff) = read_detached_handoff(&self.state_dir, &self.repo_dir) {
            let deadline = *self
                .handoff_deadline
                .get_or_insert(handoff.at + DETACHED_HANDOFF_GRACE_MS);
            if now_millis() < deadline {
                return true;
            }
        }
        false
    }

    fn failure_detail(&self) -> String {
        if !self.first_stderr.is_empty() {
            return self.first_stderr.clone();
        }
        "the run ended with an error".to_string()
    }

    /// Ends the peer and proves it gone before the owner records its outcome.
    async fn finish(&mut self, status: DetachedRunStatus, error: Option<String>) {
        if self.done {
            return;
        }
        self.done = true;
        if let Some(handle) = self.turn.take() {
            handle.abort();
        }
        let peer = self.peer.take();
        let child = self.peer_child.take();
        self.state.status = status;
        self.state.finished_at = Some(crate::journal::now_iso8601());
        self.state.error = error;
        self.state.question = None;
        close_peer(peer, child).await;
        self.persist_done();
    }

    fn persist_done(&mut self) {
        self.state.owner = Some(self.owner.clone());
        self.state.peer = self.peer_child.clone();
        self.state.updated_at = crate::journal::now_iso8601();
        let _ = write_detached_run_state(&self.directory, &self.state);
    }
}

async fn connect_peer(
    owner: &Owner,
    command: &str,
    cwd: &std::path::Path,
    permission: PermissionPolicy,
) -> std::result::Result<
    (
        Arc<AcpConnection>,
        tokio::sync::mpsc::UnboundedReceiver<AcpEvent>,
    ),
    String,
> {
    let options = AcpConnectionOptions::new(command, cwd.display().to_string())
        .with_permission_policy(permission);
    let _ = owner;
    let (peer, events) = AcpConnection::connect(options)
        .await
        .map_err(|error| error.message)?;
    Ok((Arc::new(peer), events))
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// Ends the peer and proves it gone before the owner records its outcome.
async fn close_peer(peer: Option<Arc<AcpConnection>>, child: Option<RecordedChild>) {
    if let Some(peer) = &peer {
        peer.close();
    }
    drop(peer);
    let Some(child) = child else {
        return;
    };
    let deadline = Instant::now() + Duration::from_millis(PEER_CLOSE_GRACE_MS);
    while Instant::now() < deadline && recorded_child_alive(&child) {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    if !recorded_child_alive(&child) {
        return;
    }
    unsafe {
        libc::kill(child.pid as libc::pid_t, libc::SIGKILL);
    }
    let forced = Instant::now() + Duration::from_millis(500);
    while Instant::now() < forced && recorded_child_alive(&child) {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}
