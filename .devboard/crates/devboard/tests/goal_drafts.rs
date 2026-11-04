//! The Drafts view: elaboration start, activity, questions, stop, delete, and
//! the durable run state a replacement dashboard replays.

use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use devboard::app::{App, Conn};
use devboard::config::Config;
use devboard::journal::Journal;
use devboard::protocol::Command;
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedReceiver;

static ROOT: LazyLock<PathBuf> = LazyLock::new(|| {
    let harness = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the harness directory exists");
    let root = harness
        .join(".test-tmp")
        .join(format!("goal-drafts-{}", std::process::id()));
    std::fs::create_dir_all(root.join("state")).expect("a state root");
    let binary = env!("CARGO_BIN_EXE_devboard");
    std::env::set_var("STATE_DIR", root.join("state"));
    std::env::set_var("DEVBOARD_OWNER_EXECUTABLE", binary);
    std::env::set_var(
        "AGENT_COMMAND",
        format!(
            "{binary} acp-stub --goal-draft --log={}",
            root.join("agent.log").display()
        ),
    );
    root
});

fn root() -> &'static Path {
    &ROOT
}

fn state_dir() -> PathBuf {
    root().join("state")
}

fn repo_root(label: &str) -> PathBuf {
    let repo = root().join(format!("repo-{label}"));
    let _ = std::fs::remove_dir_all(&repo);
    std::fs::create_dir_all(repo.join(".devboard").join("goal-proposals"))
        .expect("a drafts directory");
    std::fs::create_dir_all(repo.join(".devboard").join("goals")).expect("a goals directory");
    repo
}

fn write_draft(repo: &Path, name: &str, text: &str) -> String {
    std::fs::write(
        repo.join(".devboard").join("goal-proposals").join(name),
        text,
    )
    .expect("a draft");
    format!(".devboard/goal-proposals/{name}")
}

fn app(repo: &Path) -> Arc<App> {
    let config = Config {
        hostname: "127.0.0.1".to_string(),
        port: 0,
        addr_dir: repo.join("adrs"),
        repo_dir: repo.to_path_buf(),
        goal_file: repo.join("GOAL.md"),
        static_dir: None,
        agent_command: std::env::var("AGENT_COMMAND").unwrap_or_default(),
        state_dir: state_dir(),
        allowed_hosts: Vec::new(),
        token: "fixture-token".to_string(),
        bootstrap: "test-bootstrap".to_string(),
        feedback: None,
    };
    std::fs::create_dir_all(repo.join("adrs")).expect("an adrs directory");
    App::new(config, Journal::open(&state_dir(), repo, 0))
}

async fn connected(app: &Arc<App>) -> (Conn, UnboundedReceiver<String>) {
    let (outbox, inbox) = tokio::sync::mpsc::unbounded_channel();
    let conn = Conn::new(outbox);
    app.register(conn.clone()).await;
    (conn, inbox)
}

fn parse(text: &str) -> Value {
    serde_json::from_str(text).expect("a JSON frame")
}

async fn frame_matching(
    inbox: &mut UnboundedReceiver<String>,
    predicate: impl Fn(&Value) -> bool,
    millis: u64,
) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(millis);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        assert!(!remaining.is_zero(), "no frame matched before the deadline");
        let text = tokio::time::timeout(remaining, inbox.recv())
            .await
            .expect("a frame before the deadline")
            .expect("a live frame channel");
        let frame = parse(&text);
        if predicate(&frame) {
            return frame;
        }
    }
}

fn activity_contains(frame: &Value, needle: &str) -> bool {
    frame["draft"]["activity"].as_array().is_some_and(|lines| {
        lines
            .iter()
            .any(|line| line.as_str().is_some_and(|line| line.contains(needle)))
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn start_streams_activity_answers_a_question_and_stops() {
    let repo = repo_root("question");
    let path = write_draft(&repo, "ask.md", "# Ask\n\nSTUB-QUESTION\nSTUB-HANG\n");
    let app = app(&repo);
    let (conn, mut inbox) = connected(&app).await;

    app.command(&conn, Command::GetGoalDrafts).await;
    let listed = frame_matching(&mut inbox, |frame| frame["type"] == "issuesDrafts", 5000).await;
    assert_eq!(listed["drafts"][0]["path"], json!(path));
    assert_eq!(listed["drafts"][0]["heading"], json!("Ask"));
    assert_eq!(listed["runs"], json!([]));

    app.command(
        &conn,
        Command::StartGoalDraft {
            path: Some(json!(path)),
        },
    )
    .await;
    let running = frame_matching(
        &mut inbox,
        |frame| frame["type"] == "issuesDraftState" && frame["draft"]["status"] == "running",
        15000,
    )
    .await;
    assert_eq!(running["draft"]["path"], json!(path));
    assert_eq!(running["draft"]["error"], Value::Null);

    let asked = frame_matching(
        &mut inbox,
        |frame| frame["type"] == "issuesDraftState" && frame["draft"]["question"].is_object(),
        15000,
    )
    .await;
    assert!(activity_contains(&asked, "Reading the draft"));
    let question = &asked["draft"]["question"];
    assert_eq!(question["message"], json!("Choose an answer"));
    assert_eq!(question["options"][0]["label"], json!("Alpha"));
    assert_eq!(question["options"][0]["recommended"], json!(true));
    let id = question["id"].clone();

    let running_state: Value = serde_json::from_str(
        &std::fs::read_to_string(devboard::goal_drafts::goal_draft_owner_state_path(
            &state_dir(),
            &repo,
            &path,
        ))
        .expect("the running owner state"),
    )
    .expect("state JSON");
    assert_eq!(running_state["run"]["status"], "running");
    assert!(running_state["run"]["question"].is_object());
    assert!(running_state["owner"]["pid"].as_u64().is_some());
    assert!(running_state["peer"]["pid"].as_u64().is_some());

    app.command(
        &conn,
        Command::AnswerGoalDraft {
            path: Some(json!(path)),
            id: Some(id),
            value: Some(json!("Alpha")),
        },
    )
    .await;
    let answered = frame_matching(
        &mut inbox,
        |frame| {
            frame["type"] == "issuesDraftState"
                && frame["draft"]["question"] == Value::Null
                && activity_contains(frame, "Answer received: Alpha")
        },
        15000,
    )
    .await;
    assert_eq!(answered["draft"]["status"], "running");

    app.command(
        &conn,
        Command::StopGoalDraft {
            path: Some(json!(path)),
        },
    )
    .await;
    let stopped = frame_matching(
        &mut inbox,
        |frame| frame["type"] == "issuesDraftState" && frame["draft"]["status"] == "stopped",
        15000,
    )
    .await;
    assert!(stopped["draft"]["finishedAt"].is_string());
    assert_eq!(stopped["draft"]["error"], Value::Null);
    assert_eq!(stopped["draft"]["question"], Value::Null);

    let state_path = devboard::goal_drafts::goal_draft_owner_state_path(&state_dir(), &repo, &path);
    let text = std::fs::read_to_string(&state_path).expect("the owner state");
    let stored: Value = serde_json::from_str(&text).expect("state JSON");
    let keys: Vec<&String> = stored.as_object().expect("a state object").keys().collect();
    assert_eq!(
        keys,
        vec![
            "version",
            "run",
            "owner",
            "peer",
            "launcherPid",
            "supervisorPid",
            "updatedAt"
        ]
    );
    assert_eq!(stored["version"], json!(1));
    assert_eq!(stored["run"]["status"], "stopped");
    assert!(stored["owner"]["pid"].as_u64().is_some());
    assert!(stored["peer"].is_null());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_idle_draft_refuses_a_stop() {
    let repo = repo_root("idle");
    let path = write_draft(&repo, "idle.md", "# Idle\n\nNothing yet.\n");
    let app = app(&repo);
    let (conn, mut inbox) = connected(&app).await;

    app.command(
        &conn,
        Command::StopGoalDraft {
            path: Some(json!(path)),
        },
    )
    .await;
    let refusal = frame_matching(
        &mut inbox,
        |frame| frame["type"] == "issuesDraftError",
        5000,
    )
    .await;
    assert_eq!(refusal["path"], json!(path));
    assert_eq!(refusal["message"], "That draft is not being elaborated.");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_missing_draft_refuses_a_start() {
    let repo = repo_root("missing");
    let app = app(&repo);
    let (conn, mut inbox) = connected(&app).await;
    let missing = ".devboard/goal-proposals/missing.md".to_string();

    app.command(
        &conn,
        Command::StartGoalDraft {
            path: Some(json!(missing)),
        },
    )
    .await;
    let refusal = frame_matching(
        &mut inbox,
        |frame| frame["type"] == "issuesDraftError",
        5000,
    )
    .await;
    assert_eq!(refusal["path"], json!(missing));
    assert_eq!(
        refusal["message"],
        "No draft at .devboard/goal-proposals/missing.md."
    );
    assert!(!devboard::goal_drafts::goal_draft_state_directory(&state_dir(), &repo).exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_running_draft_refuses_deletion_and_deletes_once_stopped() {
    let repo = repo_root("delete");
    let path = write_draft(&repo, "keep.md", "# Keep\n\nSTUB-HANG\n");
    let app = app(&repo);
    let (conn, mut inbox) = connected(&app).await;

    app.command(
        &conn,
        Command::StartGoalDraft {
            path: Some(json!(path)),
        },
    )
    .await;
    frame_matching(
        &mut inbox,
        |frame| {
            frame["type"] == "issuesDraftState"
                && frame["draft"]["status"] == "running"
                && activity_contains(frame, "Reading the draft")
        },
        15000,
    )
    .await;

    app.command(
        &conn,
        Command::DeleteGoalDraft {
            path: Some(json!(path)),
        },
    )
    .await;
    let refusal = frame_matching(&mut inbox, |frame| frame["type"] == "error", 5000).await;
    assert_eq!(
        refusal["message"],
        "This draft is being elaborated. Stop the elaboration and delete it again."
    );
    assert!(repo
        .join(".devboard")
        .join("goal-proposals")
        .join("keep.md")
        .exists());

    app.command(
        &conn,
        Command::StopGoalDraft {
            path: Some(json!(path)),
        },
    )
    .await;
    frame_matching(
        &mut inbox,
        |frame| frame["type"] == "issuesDraftState" && frame["draft"]["status"] == "stopped",
        15000,
    )
    .await;

    app.command(
        &conn,
        Command::DeleteGoalDraft {
            path: Some(json!(path)),
        },
    )
    .await;
    let deleted = frame_matching(
        &mut inbox,
        |frame| frame["type"] == "issuesDrafts" && frame["drafts"] == json!([]),
        5000,
    )
    .await;
    assert_eq!(deleted["drafts"], json!([]));
    assert!(!repo
        .join(".devboard")
        .join("goal-proposals")
        .join("keep.md")
        .exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_new_app_replays_the_running_state_and_the_draft_text() {
    let repo = repo_root("replay");
    let path = write_draft(&repo, "replay.md", "# Replay\n\nSTUB-QUESTION\nSTUB-HANG\n");
    let first = app(&repo);
    let (conn, mut inbox) = connected(&first).await;
    first
        .command(
            &conn,
            Command::StartGoalDraft {
                path: Some(json!(path)),
            },
        )
        .await;
    frame_matching(
        &mut inbox,
        |frame| frame["type"] == "issuesDraftState" && frame["draft"]["question"].is_object(),
        15000,
    )
    .await;

    // A replacement dashboard over the same state directory sees the run.
    let replacement = app(&repo);
    let (new_conn, mut new_inbox) = connected(&replacement).await;
    replacement.command(&new_conn, Command::GetGoalDrafts).await;
    let listed = frame_matching(
        &mut new_inbox,
        |frame| {
            frame["type"] == "issuesDrafts"
                && frame["runs"]
                    .as_array()
                    .is_some_and(|runs| !runs.is_empty())
        },
        5000,
    )
    .await;
    let runs = listed["runs"].as_array().expect("runs");
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0]["status"], "running");
    assert_eq!(runs[0]["path"], json!(path));
    assert!(runs[0]["question"]["message"].is_string());
    assert!(!runs[0]["activity"].as_array().expect("activity").is_empty());

    replacement
        .command(
            &new_conn,
            Command::GetGoalDraft {
                path: Some(json!(path)),
            },
        )
        .await;
    let detail = frame_matching(
        &mut new_inbox,
        |frame| frame["type"] == "issuesDraftDetail",
        5000,
    )
    .await;
    assert_eq!(detail["draft"]["path"], json!(path));
    assert_eq!(detail["draft"]["heading"], json!("Replay"));
    assert!(detail["draft"]["text"]
        .as_str()
        .expect("text")
        .contains("STUB-QUESTION"));

    replacement
        .command(
            &new_conn,
            Command::StopGoalDraft {
                path: Some(json!(path)),
            },
        )
        .await;
    frame_matching(
        &mut new_inbox,
        |frame| frame["type"] == "issuesDraftState" && frame["draft"]["status"] == "stopped",
        15000,
    )
    .await;
}
