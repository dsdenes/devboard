//! The restart state machine: a refusal while one is in flight, the one
//! failure frame set, the when-idle upgrade, a restored wait, and a damaged
//! state file reported before any restored frame.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::mpsc;

use devboard::app::{App, Conn, ModeGate};
use devboard::config::Config;
use devboard::journal::Journal;
use devboard::protocol::Command;

static COUNTER: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
    config: Config,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let index = COUNTER.fetch_add(1, Ordering::SeqCst);
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!("restart-{label}-{}-{index}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let repo_dir = root.join("repo");
        let state_dir = repo_dir.join(".devboard").join(".tmp");
        std::fs::create_dir_all(state_dir.join("journal")).expect("a state directory");
        std::fs::create_dir_all(&repo_dir).expect("a repository");
        let config = Config {
            hostname: "127.0.0.1".to_string(),
            port: 0,
            adrs_dir: repo_dir.join("adrs"),
            repo_dir,
            goal_file: root.join("repo").join("GOAL.md"),
            static_dir: None,
            agent_command: "omp acp".to_string(),
            state_dir,
            allowed_hosts: Vec::new(),
            feedback: None,
        };
        Self { root, config }
    }

    fn app(&self) -> Arc<App> {
        App::new(
            self.config.clone(),
            Journal::open(&self.config.state_dir, &self.config.repo_dir, 0),
        )
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn client() -> (Conn, mpsc::UnboundedReceiver<String>) {
    let (outbox, inbox) = mpsc::unbounded_channel();
    (Conn::new(outbox), inbox)
}

fn drain(inbox: &mut mpsc::UnboundedReceiver<String>) -> Vec<Value> {
    let mut frames = Vec::new();
    while let Ok(text) = inbox.try_recv() {
        frames.push(serde_json::from_str(&text).expect("a frame"));
    }
    frames
}

fn state_files(config: &Config) {
    devboard::detached_run::write_detached_handoff(&config.state_dir, &config.repo_dir);
    devboard::goal_drafts::write_goal_draft_handoff(
        &config.state_dir,
        &config.repo_dir,
        devboard::goal_drafts::GoalDraftHandoff {
            at: 1,
            pid: std::process::id(),
        },
    );
}

#[tokio::test]
async fn a_failed_restart_clears_the_handoffs_and_tells_every_page() {
    let fixture = Fixture::new("failed");
    let config = fixture.config.clone();
    let app = fixture.app();
    state_files(&config);
    app.set_restart_hook(Arc::new(|| Err("the launcher could not start".to_string())));
    let (conn, mut inbox) = client();
    app.register(conn.clone()).await;
    app.command(&conn, Command::RestartServer { when_idle: None })
        .await;
    let frames = drain(&mut inbox);
    let states: Vec<&Value> = frames
        .iter()
        .filter(|frame| frame["type"] == "versionState")
        .collect();
    assert_eq!(states.len(), 1, "{frames:?}");
    let replacement = &states[0]["replacement"];
    assert_eq!(replacement["error"], "the launcher could not start");
    assert!(replacement.get("running").is_some());
    assert!(replacement.get("installed").is_some());
    assert!(
        frames
            .iter()
            .any(|frame| frame["type"] == "error"
                && frame["message"] == "the launcher could not start"),
        "{frames:?}"
    );
    assert!(
        !devboard::detached_run::detached_run_handoff_path(&config.state_dir, &config.repo_dir)
            .exists(),
        "the detached handoff is removed"
    );
    assert!(
        !devboard::goal_drafts::goal_draft_handoff_path(&config.state_dir, &config.repo_dir)
            .exists(),
        "the goal-draft handoff is removed"
    );
    let state = app.version_state();
    assert_eq!(
        state["replacement"]["error"],
        "the launcher could not start"
    );
}

#[tokio::test]
async fn a_second_restart_while_one_is_in_flight_is_refused() {
    let fixture = Fixture::new("in-flight");
    let app = fixture.app();
    app.set_restart_hook(Arc::new(|| Ok(())));
    let (conn, mut inbox) = client();
    app.register(conn.clone()).await;
    app.command(&conn, Command::RestartServer { when_idle: None })
        .await;
    let frames = drain(&mut inbox);
    assert!(
        frames
            .iter()
            .any(|frame| frame["type"] == "serverRestarting"),
        "{frames:?}"
    );
    app.command(&conn, Command::RestartServer { when_idle: None })
        .await;
    let frames = drain(&mut inbox);
    assert!(
        frames.iter().any(|frame| frame["type"] == "error"
            && frame["message"] == "A server restart is already in progress."),
        "{frames:?}"
    );
}

struct Busy;

impl ModeGate for Busy {
    fn has_active_work(&self) -> bool {
        true
    }

    fn busy_reason(&self) -> Option<String> {
        Some("A run is active.".to_string())
    }

    fn abort_active_work(&self) {}
}

#[tokio::test]
async fn a_when_idle_restart_announces_the_wait_and_a_failure_is_an_error() {
    let fixture = Fixture::new("when-idle");
    let app = fixture.app();
    app.shared.register_gate("busy", Arc::new(Busy));
    app.set_restart_hook(Arc::new(|| Err("the launcher could not start".to_string())));
    let (conn, mut inbox) = client();
    app.register(conn.clone()).await;
    app.command(
        &conn,
        Command::RestartServer {
            when_idle: Some(json!(true)),
        },
    )
    .await;
    let frames = drain(&mut inbox);
    assert!(
        frames.iter().any(|frame| frame["type"] == "upgradePending"),
        "{frames:?}"
    );
    assert!(
        !frames
            .iter()
            .any(|frame| frame["type"] == "serverRestarting"),
        "a when-idle restart waits: {frames:?}"
    );
    // The wait ends when the work does and the launcher fails.
    let error = app.begin_restart().expect_err("the hook fails");
    assert_eq!(error, "the launcher could not start");
    let frames = drain(&mut inbox);
    assert!(
        frames
            .iter()
            .any(|frame| frame["type"] == "error"
                && frame["message"] == "the launcher could not start"),
        "{frames:?}"
    );
    assert!(!app.restart_waits_for_idle());
}

#[tokio::test]
async fn a_restored_restart_when_idle_resumes_waiting() {
    let fixture = Fixture::new("restored");
    let config = fixture.config.clone();
    let mut state = devboard::state::default_state();
    state["restartWhenIdle"] = json!(true);
    let path = devboard::state::state_file(&config.state_dir, &config.repo_dir);
    std::fs::create_dir_all(path.parent().unwrap()).expect("a state directory");
    std::fs::write(&path, devboard::state::state_envelope(&state)).expect("a state file");
    let app = fixture.app();
    assert!(
        app.restart_waits_for_idle(),
        "a restored wait is resumed, not ignored"
    );
}

#[tokio::test]
async fn a_damaged_state_file_reports_once_before_the_restored_state() {
    let fixture = Fixture::new("damaged");
    let config = fixture.config.clone();
    let path = devboard::state::state_file(&config.state_dir, &config.repo_dir);
    std::fs::create_dir_all(path.parent().unwrap()).expect("a state directory");
    std::fs::write(&path, "{ not json").expect("a damaged state file");
    let app = fixture.app();
    let (conn, mut inbox) = client();
    app.register(conn.clone()).await;
    app.open(&conn).await;
    let frames = drain(&mut inbox);
    let first = frames.first().expect("a first frame");
    assert_eq!(first["type"], "error", "{frames:?}");
    assert!(
        first["message"]
            .as_str()
            .is_some_and(|message| message.contains("Could not restore")),
        "{frames:?}"
    );
    assert_eq!(
        frames
            .iter()
            .filter(|frame| frame["type"] == "error")
            .count(),
        1,
        "the damage is reported once"
    );
    let (other, mut inbox) = client();
    app.register(other.clone()).await;
    app.open(&other).await;
    let frames = drain(&mut inbox);
    assert!(
        frames.iter().all(|frame| frame["type"] != "error"),
        "a second client is not told again: {frames:?}"
    );
}
