//! The detached owner of one running draft elaboration.
//!
//! The dashboard starts one owner per draft and never holds the ACP peer
//! itself. The owner spawns the agent, streams its activity and question into
//! the draft-keyed state file, and consumes answer/stop commands from the
//! control directory beside it. Because the owner is in its own session, it
//! survives any dashboard exit: the next dashboard adopts the same owner and
//! agent without a reload handoff. Only Stop, a finished turn, or a real
//! failure ends it.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};

use crate::acp::{AcpConnection, AcpConnectionOptions, AcpEvent, AcpId};
use crate::goal_drafts::{
    append_activity_line, canonical_process_path, goal_draft_control_directory,
    read_goal_draft_owner_state, recorded_child_alive, self_child, take_goal_draft_owner_commands,
    write_goal_draft_owner_state, GoalDraftOwnerCommand, GoalDraftOwnerState, GoalDraftQuestion,
    GoalDraftRun, GoalDraftStatus, RecordedChild, GOAL_DRAFT_OWNER_EXITED,
    GOAL_DRAFT_OWNER_VERSION,
};
use crate::workers::WorkerInvocation;

/// How often the owner consumes commands and checks its supervisor.
const OWNER_CHECK_MS: u64 = 200;
/// How long the owner waits for the peer to exit before it forces it.
const PEER_CLOSE_GRACE_MS: u64 = 1_500;
/// How long the owner waits for the dashboard's running state to appear.
const LAUNCH_WAIT_MS: u64 = 2_000;

/// Runs one draft's owner until its elaboration ends; the entry point of its
/// process.
pub async fn run(invocation: &WorkerInvocation) -> Result<()> {
    let repo_dir = invocation.repo_dir.clone();
    let state_dir = invocation.state_dir.clone();
    let Some(draft_path) = invocation.option("path").map(str::to_string) else {
        anyhow::bail!("goal-draft owner: --repo, --state-dir, and --path are required.");
    };

    // The dashboard writes the running state before it spawns this process.
    let deadline = Instant::now() + Duration::from_millis(LAUNCH_WAIT_MS);
    let mut stored = read_goal_draft_owner_state(&state_dir, &repo_dir, &draft_path);
    while !stored
        .as_ref()
        .is_some_and(|state| state.run.status == GoalDraftStatus::Running)
    {
        if Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
        stored = read_goal_draft_owner_state(&state_dir, &repo_dir, &draft_path);
    }
    let Some(stored) = stored else {
        return Ok(());
    };
    if stored.run.status != GoalDraftStatus::Running {
        return Ok(());
    }

    let mut owner = Owner {
        repo_dir: repo_dir.clone(),
        state_dir: state_dir.clone(),
        draft_path: draft_path.clone(),
        control: goal_draft_control_directory(&state_dir, &repo_dir, &draft_path),
        run: stored.run.clone(),
        owner: self_child(&repo_dir),
        launcher_pid: stored.launcher_pid,
        supervisor_pid: stored.supervisor_pid,
        peer: None,
        peer_child: stored.peer.clone(),
        first_stderr: String::new(),
        done: false,
    };
    // The owner publishes the identity its liveness is judged by before it
    // does anything else; the launcher that forked this process is never it.
    owner.persist();

    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .context("listening for SIGTERM")?;
    #[cfg(unix)]
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
        .context("listening for SIGINT")?;

    let (peer, mut events) = match connect_peer(&owner).await {
        Ok(connected) => connected,
        Err(message) => {
            owner.finish(GoalDraftStatus::Failed, Some(message)).await;
            return Ok(());
        }
    };
    owner.peer_child = peer.pid().map(|pid| RecordedChild {
        pid,
        argv: peer.argv(),
        cwd: canonical_process_path(&repo_dir).display().to_string(),
    });
    owner.peer = Some(Arc::clone(&peer));
    owner.persist();

    let prompt = format!("/goal-draft {}", owner.run.path.clone().unwrap_or_default());
    let runner = Arc::clone(&peer);
    let (turn_sender, mut turn) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let _ = turn_sender.send(runner.run(&prompt).await);
    });

    let mut ticker = tokio::time::interval(Duration::from_millis(OWNER_CHECK_MS));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = ticker.tick() => {
                for command in take_goal_draft_owner_commands(&owner.control) {
                    match command {
                        GoalDraftOwnerCommand::Stop => {
                            owner.finish(GoalDraftStatus::Stopped, None).await;
                            return Ok(());
                        }
                        GoalDraftOwnerCommand::Answer { id, value } => {
                            owner.apply_answer(id, &value).await;
                        }
                    }
                }
                if owner.done {
                    return Ok(());
                }
                // A dashboard's exit never ends this owner: the agent and its
                // prompt belong to this process, and the next dashboard
                // adopts it as it stands.
            }
            Some(event) = events.recv() => {
                owner.apply_event(event);
            }
            result = &mut turn => {
                if let Ok(Ok(_)) = result {
                    owner.finish(GoalDraftStatus::Succeeded, None).await;
                } else {
                    let detail = match result {
                        Ok(Err(error)) if !error.message.is_empty() => error.message,
                        Ok(Ok(_)) | Ok(Err(_)) | Err(_) => owner.failure_detail(),
                    };
                    owner.finish(GoalDraftStatus::Failed, Some(detail)).await;
                }
                return Ok(());
            }
            _ = terminate.recv() => {
                owner
                    .finish(
                        GoalDraftStatus::Failed,
                        Some(GOAL_DRAFT_OWNER_EXITED.to_string()),
                    )
                    .await;
                return Ok(());
            }
            _ = interrupt.recv() => {
                owner
                    .finish(
                        GoalDraftStatus::Failed,
                        Some(GOAL_DRAFT_OWNER_EXITED.to_string()),
                    )
                    .await;
                return Ok(());
            }
        }
    }
}

/// One draft's live owner: the peer, its run, and the identity it publishes.
struct Owner {
    repo_dir: PathBuf,
    state_dir: PathBuf,
    draft_path: String,
    control: PathBuf,
    run: GoalDraftRun,
    owner: RecordedChild,
    launcher_pid: Option<u32>,
    supervisor_pid: Option<u32>,
    peer: Option<Arc<AcpConnection>>,
    peer_child: Option<RecordedChild>,
    first_stderr: String,
    done: bool,
}

impl Owner {
    fn persist(&self) {
        write_goal_draft_owner_state(
            &self.state_dir,
            &self.repo_dir,
            &self.draft_path,
            &GoalDraftOwnerState {
                version: GOAL_DRAFT_OWNER_VERSION,
                run: self.run.clone(),
                owner: Some(self.owner.clone()),
                peer: self.peer_child.clone(),
                launcher_pid: self.launcher_pid,
                supervisor_pid: self.supervisor_pid,
                updated_at: crate::journal::now_iso8601(),
            },
        );
    }

    /// Ends the peer and proves it gone before the owner records its outcome.
    async fn finish(&mut self, status: GoalDraftStatus, error: Option<String>) {
        if self.done {
            return;
        }
        self.done = true;
        let peer = self.peer.take();
        let child = self.peer_child.take();
        self.run.status = status;
        self.run.finished_at = Some(crate::journal::now_iso8601());
        self.run.error = error;
        self.run.question = None;
        close_peer(peer, child).await;
        self.persist();
    }

    fn apply_event(&mut self, event: AcpEvent) {
        if self.done {
            return;
        }
        match event {
            AcpEvent::Activity(entry) => {
                append_activity_line(&mut self.run.activity, &entry.text, entry.append);
                self.persist();
            }
            AcpEvent::Question(question) => {
                self.run.question = Some(GoalDraftQuestion {
                    id: question.id,
                    message: question.message,
                    options: question.options,
                });
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
            AcpEvent::Text(_) | AcpEvent::SessionUpdate => {}
        }
    }

    async fn apply_answer(&mut self, id: AcpId, value: &str) {
        if self.done {
            return;
        }
        let Some(question) = self.run.question.clone() else {
            return;
        };
        if question.id.as_key() != id.as_key() {
            return;
        }
        let Some(peer) = self.peer.clone() else {
            return;
        };
        if !peer.answer(&id, value).await {
            return;
        }
        self.run.question = None;
        self.persist();
    }

    fn failure_detail(&self) -> String {
        if !self.first_stderr.is_empty() {
            return self.first_stderr.clone();
        }
        "the elaboration agent ended with an error".to_string()
    }
}

async fn connect_peer(
    owner: &Owner,
) -> std::result::Result<
    (
        Arc<AcpConnection>,
        tokio::sync::mpsc::UnboundedReceiver<AcpEvent>,
    ),
    String,
> {
    let base: std::collections::HashMap<String, Option<String>> = std::env::vars()
        .map(|(key, value)| (key, Some(value)))
        .collect();
    let environment = crate::providers::worker_peer_environment(
        &owner.state_dir,
        &owner.repo_dir,
        base,
        crate::providers::ProviderOptions::default(),
    )
    .await
    .map_err(|error| error.message)?;
    let environment: std::collections::HashMap<String, String> = environment
        .into_iter()
        .filter_map(|(key, value)| value.map(|value| (key, value)))
        .collect();
    let command = format!("{} --no-skills", agent_command());
    let options = AcpConnectionOptions::new(command, owner.repo_dir.display().to_string())
        .with_starter("Goal draft")
        .with_env(environment);
    let (peer, events) = AcpConnection::connect(options)
        .await
        .map_err(|error| error.message)?;
    Ok((Arc::new(peer), events))
}

fn agent_command() -> String {
    std::env::var("AGENT_COMMAND")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "omp acp".to_string())
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
