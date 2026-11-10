//! The Drafts view: elaboration start, activity, questions, stop, delete, and
//! the durable run state a replacement dashboard replays.

use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use devboard::acp::AcpId;
use devboard::app::{App, Conn};
use devboard::command::Command;
use devboard::config::Config;
use devboard::goal_drafts::GoalDraftQuestion;
use devboard::journal::Journal;
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
        adrs_dir: repo.join("adrs"),
        repo_dir: repo.to_path_buf(),
        goal_file: repo.join("GOAL.md"),
        static_dir: None,
        agent_command: std::env::var("AGENT_COMMAND").unwrap_or_default(),
        state_dir: state_dir(),
        allowed_hosts: Vec::new(),
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

/// The goal-draft tests share process-wide environment variables and the
/// owner-executable override, so they run one at a time.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn serial() -> tokio::sync::MutexGuard<'static, ()> {
    SERIAL.lock().await
}

/// Restores the owner executable a test replaced when it ends.
struct RestoreOwnerExecutable(Option<String>);

impl Drop for RestoreOwnerExecutable {
    fn drop(&mut self) {
        match self.0.take() {
            Some(value) => std::env::set_var("DEVBOARD_OWNER_EXECUTABLE", value),
            None => std::env::remove_var("DEVBOARD_OWNER_EXECUTABLE"),
        }
    }
}

fn use_owner_executable(path: &Path) -> RestoreOwnerExecutable {
    let previous = std::env::var("DEVBOARD_OWNER_EXECUTABLE").ok();
    std::env::set_var("DEVBOARD_OWNER_EXECUTABLE", path);
    RestoreOwnerExecutable(previous)
}

fn executable_script(path: &Path, body: &str) {
    std::fs::write(path, body).expect("a script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .expect("an executable script");
    }
}

/// The durable owner state of one draft, as the dashboard reads it.
fn owner_state(repo: &Path, path: &str) -> Option<Value> {
    let text = std::fs::read_to_string(devboard::goal_drafts::goal_draft_owner_state_path(
        &state_dir(),
        repo,
        path,
    ))
    .ok()?;
    serde_json::from_str(&text).ok()
}

fn owner_pid_of(state: &Value) -> Option<u32> {
    state["owner"]["pid"].as_u64().map(|pid| pid as u32)
}

fn process_alive(pid: u32) -> bool {
    devboard::supervision::live_process(pid)
}

fn kill_pid(pid: u32) {
    if !devboard::supervision::live_process(pid) {
        return;
    }
    let _ = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status();
}

async fn wait_until(mut predicate: impl FnMut() -> bool, millis: u64) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_millis(millis);
    while std::time::Instant::now() < deadline {
        if predicate() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    predicate()
}

/// Writes the running record a dashboard writes before it forks an owner.
fn write_running_record(repo: &Path, path: &str, launcher: u32, supervisor: u32) {
    write_running_record_since(
        repo,
        path,
        launcher,
        supervisor,
        devboard::journal::now_iso8601(),
    );
}

fn write_running_record_since(
    repo: &Path,
    path: &str,
    launcher: u32,
    supervisor: u32,
    started: String,
) {
    use devboard::goal_drafts::{
        GoalDraftOwnerState, GoalDraftRun, GoalDraftStatus, GOAL_DRAFT_OWNER_VERSION,
    };
    let state = GoalDraftOwnerState {
        version: GOAL_DRAFT_OWNER_VERSION,
        run: GoalDraftRun {
            status: GoalDraftStatus::Running,
            path: Some(path.to_string()),
            started_at: Some(started.clone()),
            finished_at: None,
            error: None,
            activity: Vec::new(),
            question: None,
        },
        owner: None,
        peer: None,
        launcher_pid: Some(launcher),
        supervisor_pid: Some(supervisor),
        updated_at: started,
        applied_answer: None,
    };
    devboard::goal_drafts::write_goal_draft_owner_state(&state_dir(), repo, path, &state);
}

/// The record this test process publishes as one draft's owner: the run waits
/// on a question until the owner applies the answer, after which the same
/// record carries no question. The test process is the recorded owner, so the
/// dashboard's liveness proof accepts it the way it accepts a peer.
fn write_owner_state(repo: &Path, path: &str, question: Option<GoalDraftQuestion>) {
    use devboard::goal_drafts::{
        self_child, GoalDraftOwnerState, GoalDraftRun, GoalDraftStatus, GOAL_DRAFT_OWNER_VERSION,
    };
    let cwd = std::env::current_dir().expect("a working directory");
    let now = devboard::journal::now_iso8601();
    let activity = if question.is_some() {
        "Waiting for the answer"
    } else {
        "Answer received: Alpha"
    };
    let state = GoalDraftOwnerState {
        version: GOAL_DRAFT_OWNER_VERSION,
        run: GoalDraftRun {
            status: GoalDraftStatus::Running,
            path: Some(path.to_string()),
            started_at: Some(now.clone()),
            finished_at: None,
            error: None,
            activity: vec![activity.to_string()],
            question,
        },
        owner: Some(self_child(&cwd)),
        peer: None,
        launcher_pid: Some(std::process::id()),
        supervisor_pid: Some(std::process::id()),
        updated_at: now,
        applied_answer: None,
    };
    devboard::goal_drafts::write_goal_draft_owner_state(&state_dir(), repo, path, &state);
}

/// One owner this test started the way a dashboard starts it.
struct RawOwner {
    child: std::process::Child,
}

impl RawOwner {
    fn kill(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for RawOwner {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn spawn_owner_process(repo: &Path, path: &str, agent_command: &str) -> RawOwner {
    let binary = env!("CARGO_BIN_EXE_devboard");
    let child = std::process::Command::new(binary)
        .args([
            "worker".to_string(),
            "goal-draft".to_string(),
            "--repo".to_string(),
            repo.display().to_string(),
            "--state-dir".to_string(),
            state_dir().display().to_string(),
            "--path".to_string(),
            path.to_string(),
        ])
        .current_dir(repo)
        .env("AGENT_COMMAND", agent_command)
        .env("STATE_DIR", state_dir())
        .env("REPO_DIR", repo)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("a draft owner");
    RawOwner { child }
}

/// A test-owned ACP agent that keeps streaming activity, asks one question,
/// and never ends its turn, so a live owner has something to survive on.
fn streaming_agent_command() -> String {
    let path = root().join("streaming-agent.py");
    executable_script(
        &path,
        r#"#!/usr/bin/env python3
import json
import sys
import threading
import time

out = sys.stdout
lock = threading.Lock()

def send(message):
    with lock:
        out.write(json.dumps(message) + "\n")
        out.flush()

lines = 0

def stream(text):
    global lines
    lines += 1
    send({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": "live-session",
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": text},
                "messageId": "live-elaboration-%d" % lines,
            },
        },
    })

def tick():
    count = 0
    while True:
        time.sleep(0.5)
        count += 1
        stream("Still elaborating (%d)" % count)
        if count == 4:
            send({
                "jsonrpc": "2.0",
                "id": 7001,
                "method": "elicitation/create",
                "params": {
                    "mode": "form",
                    "sessionId": "live-session",
                    "message": "Choose an answer",
                    "requestedSchema": {
                        "type": "object",
                        "properties": {
                            "value": {
                                "type": "string",
                                "title": "Choose an answer",
                                "oneOf": [
                                    {
                                        "const": "Alpha",
                                        "title": "Alpha",
                                        "description": "Alpha leads to the first outcome.",
                                    },
                                    {
                                        "const": "Beta",
                                        "title": "Beta",
                                        "description": "Beta leads to the second outcome.",
                                    },
                                ],
                            }
                        },
                        "required": ["value"],
                    },
                },
            })

threading.Thread(target=tick, daemon=True).start()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        message = json.loads(line)
    except ValueError:
        continue
    method = message.get("method")
    wire_id = message.get("id")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": wire_id, "result": {"protocolVersion": 1}})
    elif method == "session/new":
        send({"jsonrpc": "2.0", "id": wire_id, "result": {"sessionId": "live-session"}})
    elif method == "session/prompt":
        stream("Reading the draft")
    elif wire_id == 7001 and "result" in message:
        content = message.get("result", {}).get("content") or {}
        stream("Answer received: %s" % content.get("value", ""))
"#,
    );
    format!("python3 {}", path.display())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn start_streams_activity_answers_a_question_and_stops() {
    let _serial = serial().await;
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
    let answered_id = id.clone();

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
            "updatedAt",
            "appliedAnswer"
        ]
    );
    assert_eq!(stored["version"], json!(1));
    assert_eq!(stored["run"]["status"], "stopped");
    assert_eq!(stored["appliedAnswer"], answered_id);
    assert!(stored["owner"]["pid"].as_u64().is_some());
    assert!(stored["peer"].is_null());
}

/// The page answers over one HTTP request, so that reply must carry the state
/// that confirms the answer: it is the only frame the page reads before its
/// next poll, and the poll cadence is longer than the UI latency budget. The
/// test stands in for the owner's control tick, so the reply's contents never
/// depend on how fast a live peer happens to run.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_answer_replies_with_its_applied_state() {
    let _serial = serial().await;
    let repo = repo_root("answer-reply");
    let path = ".devboard/goal-proposals/ask.md".to_string();
    let question = GoalDraftQuestion {
        id: AcpId::from_value(&json!(9)).expect("a question id"),
        message: "Choose an answer".to_string(),
        options: Vec::new(),
    };
    write_owner_state(&repo, &path, Some(question));

    let control = devboard::goal_drafts::goal_draft_control_directory(&state_dir(), &repo, &path);
    let applied_repo = repo.clone();
    let applied_path = path.clone();
    let tick = tokio::spawn(async move {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(5000);
        while tokio::time::Instant::now() < deadline {
            if std::fs::read_dir(&control).is_ok_and(|mut entries| entries.next().is_some()) {
                write_owner_state(&applied_repo, &applied_path, None);
                return true;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        false
    });

    let app = app(&repo);
    let frames = app
        .dispatch_captured(Command::AnswerGoalDraft {
            path: Some(json!(path)),
            id: Some(json!(9)),
            value: Some(json!("Alpha")),
        })
        .await;
    assert!(
        tick.await.expect("the owner tick"),
        "the answer reached its owner"
    );
    let answered = frames.iter().find(|frame| {
        frame["type"] == "issuesDraftState"
            && frame["draft"]["path"] == json!(path)
            && frame["draft"]["question"] == Value::Null
    });
    assert!(
        answered.is_some(),
        "the reply carries the applied state: {frames:?}"
    );
}

/// The state one owner publishes after it applies answer 9 and its peer asks
/// the next question in the same tick: the applied run state never holds a
/// "no question" moment a reader could observe, only the acknowledgement of
/// the id that owner applied.
fn write_answered_state(repo: &Path, path: &str) {
    let now = devboard::journal::now_iso8601();
    let cwd = std::env::current_dir().expect("a working directory");
    let state = json!({
        "version": devboard::goal_drafts::GOAL_DRAFT_OWNER_VERSION,
        "run": {
            "status": "running",
            "path": path,
            "startedAt": now.clone(),
            "finishedAt": null,
            "error": null,
            "activity": ["Answer received: Alpha"],
            "question": {
                "id": 10,
                "message": "Choose the next answer",
                "options": [],
            },
        },
        "owner": devboard::goal_drafts::self_child(&cwd).to_json(),
        "peer": null,
        "launcherPid": std::process::id(),
        "supervisorPid": std::process::id(),
        "updatedAt": now,
        "appliedAnswer": 9,
    });
    let target = devboard::goal_drafts::goal_draft_owner_state_path(&state_dir(), repo, path);
    let temporary = target.with_extension("json.tmp");
    std::fs::write(&temporary, devboard::jsjson::stringify(&state)).expect("the owner state");
    std::fs::rename(&temporary, &target).expect("an atomic owner state");
}

/// A peer that asks its next question immediately never leaves the applied
/// state visible as "no question", so the reply must follow the answer the
/// owner recorded rather than wait out the deadline for a state it cannot
/// catch.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_answer_replies_from_the_acknowledgement_inside_its_budget() {
    let _serial = serial().await;
    let repo = repo_root("answer-ack");
    let path = ".devboard/goal-proposals/ask.md".to_string();
    write_owner_state(
        &repo,
        &path,
        Some(GoalDraftQuestion {
            id: AcpId::from_value(&json!(9)).expect("a question id"),
            message: "Choose an answer".to_string(),
            options: Vec::new(),
        }),
    );

    let control = devboard::goal_drafts::goal_draft_control_directory(&state_dir(), &repo, &path);
    let answered_repo = repo.clone();
    let answered_path = path.clone();
    let tick = tokio::spawn(async move {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(5000);
        while tokio::time::Instant::now() < deadline {
            if std::fs::read_dir(&control).is_ok_and(|mut entries| entries.next().is_some()) {
                write_answered_state(&answered_repo, &answered_path);
                return true;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        false
    });

    let app = app(&repo);
    let started = tokio::time::Instant::now();
    let frames = app
        .dispatch_captured(Command::AnswerGoalDraft {
            path: Some(json!(path)),
            id: Some(json!(9)),
            value: Some(json!("Alpha")),
        })
        .await;
    let elapsed = started.elapsed();
    assert!(
        tick.await.expect("the owner tick"),
        "the answer reached its owner"
    );
    // A dispatched reply keeps its 250 ms quiet window after the frame; the
    // bound proves the handler followed the acknowledgement rather than
    // waiting out the 700 ms deadline.
    assert!(
        elapsed < Duration::from_millis(650),
        "the reply follows the acknowledgement instead of the deadline: {elapsed:?}"
    );
    let answered = frames.iter().find(|frame| {
        frame["type"] == "issuesDraftState"
            && frame["draft"]["path"] == json!(path)
            && frame["draft"]["question"]["id"] == json!(10)
    });
    assert!(
        answered.is_some(),
        "the reply carries the state the owner applied: {frames:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_idle_draft_refuses_a_stop() {
    let _serial = serial().await;
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
    let _serial = serial().await;
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

/// A draft read is one file: it answers on the request's own handle and never
/// joins the watcher's replay list, so reads never accumulate there.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_draft_read_answers_its_request_without_joining_the_watcher() {
    let _serial = serial().await;
    let repo = repo_root("read-request");
    let path = write_draft(&repo, "read.md", "# Read\n\nBody.\n");
    let app = app(&repo);
    let (outbox, mut inbox) = tokio::sync::mpsc::unbounded_channel();
    let conn = Conn::new_request(outbox);

    app.command(
        &conn,
        Command::GetGoalDraft {
            path: Some(json!(path)),
        },
    )
    .await;
    let detail = frame_matching(
        &mut inbox,
        |frame| frame["type"] == "issuesDraftDetail",
        5000,
    )
    .await;
    assert_eq!(detail["draft"]["path"], json!(path));
    assert_eq!(
        devboard::goal_drafts::watcher_subscriber_count(&repo, &state_dir()),
        0,
        "the read's request handle is gone; it never joined the replay list"
    );
}

/// A start reads its own draft and run, forks one owner, and answers the
/// request that asked for it. Its handle never joins the watcher's replay
/// list, so a page that polls and starts for hours keeps the click cost flat.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_draft_start_answers_its_request_without_joining_the_watcher() {
    let _serial = serial().await;
    let repo = repo_root("start-request");
    let path = write_draft(&repo, "start.md", "# Start\n\nSTUB-HANG\n");
    let app = app(&repo);
    let (live, mut live_inbox) = connected(&app).await;
    app.command(&live, Command::GetGoalDrafts).await;
    frame_matching(
        &mut live_inbox,
        |frame| frame["type"] == "issuesDrafts",
        5000,
    )
    .await;
    assert_eq!(
        devboard::goal_drafts::watcher_subscriber_count(&repo, &state_dir()),
        1
    );
    // The page polled the list and opened the draft before it clicked Start;
    // those request handles are gone and must leave nothing behind.
    for _ in 0..8 {
        app.dispatch_captured(Command::GetGoalDrafts).await;
        app.dispatch_captured(Command::GetGoalDraft {
            path: Some(json!(path.clone())),
        })
        .await;
    }
    assert_eq!(
        devboard::goal_drafts::watcher_subscriber_count(&repo, &state_dir()),
        1,
        "a page's requests never accumulate on the replay list"
    );

    let frames = app
        .dispatch_captured(Command::StartGoalDraft {
            path: Some(json!(path.clone())),
        })
        .await;
    let running = frames
        .iter()
        .find(|frame| frame["type"] == "issuesDraftState")
        .expect("the start answered its request");
    assert_eq!(running["draft"]["path"], json!(path));
    assert_eq!(running["draft"]["status"], json!("running"));
    assert_eq!(
        devboard::goal_drafts::watcher_subscriber_count(&repo, &state_dir()),
        1,
        "the start's request handle is gone; only the page's stays"
    );

    app.command(
        &live,
        Command::StopGoalDraft {
            path: Some(json!(path)),
        },
    )
    .await;
    let stopped = frame_matching(
        &mut live_inbox,
        |frame| frame["type"] == "issuesDraftState" && frame["draft"]["status"] == "stopped",
        15000,
    )
    .await;
    assert!(stopped["draft"]["finishedAt"].is_string());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_running_draft_refuses_deletion_and_deletes_once_stopped() {
    let _serial = serial().await;
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
    let _serial = serial().await;
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_slow_owner_launcher_is_not_a_dead_owner() {
    let _serial = serial().await;
    let repo = repo_root("slow-launcher");
    let path = write_draft(&repo, "slow.md", "# Slow\n\nSTUB-HANG\n");
    let binary = env!("CARGO_BIN_EXE_devboard");
    let launcher = root().join("slow-launcher.sh");
    executable_script(
        &launcher,
        &format!("#!/bin/sh\nsleep 0.3\nexec {binary} \"$@\"\n"),
    );
    let _restore = use_owner_executable(&launcher);

    let app = app(&repo);
    let (conn, mut inbox) = connected(&app).await;
    app.command(
        &conn,
        Command::StartGoalDraft {
            path: Some(json!(path)),
        },
    )
    .await;

    // A run whose owner has not claimed yet is never a failure.
    let deadline = std::time::Instant::now() + Duration::from_millis(1000);
    let mut final_state = None;
    while std::time::Instant::now() < deadline {
        let state = owner_state(&repo, &path).expect("the running owner state");
        assert_eq!(state["run"]["status"], "running", "{state}");
        assert_eq!(state["run"]["error"], Value::Null, "{state}");
        final_state = Some(state);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let mut state = final_state.expect("a sample");
    // A loaded host may start the exec yet not finish it inside the first
    // second; the claim is still the owner's own, and the run stays running.
    let claim_deadline = std::time::Instant::now() + Duration::from_millis(5000);
    while owner_pid_of(&state).is_none() && std::time::Instant::now() < claim_deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
        state = owner_state(&repo, &path).expect("the running owner state");
        assert_eq!(state["run"]["status"], "running", "{state}");
        assert_eq!(state["run"]["error"], Value::Null, "{state}");
    }
    let pid = owner_pid_of(&state).expect("the owner published its identity");
    let recorded: Vec<String> = state["owner"]["argv"]
        .as_array()
        .expect("an argv")
        .iter()
        .map(|entry| entry.as_str().expect("an argument").to_string())
        .collect();
    assert_eq!(
        Some(recorded),
        devboard::supervision::process_argv(pid),
        "the recorded argv is the owner's own"
    );
    let cwd = std::fs::read_link(format!("/proc/{pid}/cwd")).expect("the owner cwd");
    assert_eq!(
        state["owner"]["cwd"].as_str().expect("a cwd"),
        cwd.display().to_string(),
        "the recorded cwd is the owner's own"
    );

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
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_live_owner_survives_a_supervisor_exit_and_a_new_app_adopts_it() {
    let _serial = serial().await;
    let repo = repo_root("survive");
    let path = write_draft(&repo, "live.md", "# Live\n\nStill working.\n");
    let mut launcher = std::process::Command::new("sleep")
        .arg("3600")
        .spawn()
        .expect("a launcher stand-in");
    let mut supervisor = std::process::Command::new("sleep")
        .arg("3600")
        .spawn()
        .expect("a supervisor stand-in");
    write_running_record(&repo, &path, launcher.id(), supervisor.id());

    // The real owner starts from the record the dead dashboard left.
    let owner = spawn_owner_process(&repo, &path, &streaming_agent_command());
    let mut claimed_pid = None;
    let claimed = wait_until(
        || {
            let state = owner_state(&repo, &path);
            claimed_pid = state.as_ref().and_then(owner_pid_of);
            claimed_pid.is_some()
        },
        5000,
    )
    .await;
    assert!(claimed, "the owner claimed its identity");
    let owner_pid = claimed_pid.expect("a claimed pid");

    // The dashboard exits: its lease vanishes and its recorded pids are gone.
    let _ = std::fs::remove_file(devboard::goal_drafts::goal_draft_lease_path(
        &state_dir(),
        &repo,
    ));
    let _ = launcher.kill();
    let _ = launcher.wait();
    let _ = supervisor.kill();
    let _ = supervisor.wait();
    assert!(
        !devboard::goal_drafts::goal_draft_handoff_path(&state_dir(), &repo).exists(),
        "no handoff is present"
    );

    let initial_activity = owner_state(&repo, &path)
        .expect("the running state")
        .pointer("/run/activity")
        .and_then(Value::as_array)
        .expect("an activity")
        .len();
    let mut last_activity = initial_activity;
    let mut grew = 0;
    let started = std::time::Instant::now();
    while started.elapsed() < Duration::from_millis(15_000) {
        let state = owner_state(&repo, &path).expect("the owner state stays readable");
        assert_eq!(
            state["run"]["status"], "running",
            "a live owner is never failed: {state}"
        );
        assert_eq!(owner_pid_of(&state), Some(owner_pid), "the same owner pid");
        assert!(devboard::supervision::live_process(owner_pid));
        let activity = state
            .pointer("/run/activity")
            .and_then(Value::as_array)
            .expect("an activity")
            .len();
        if activity > last_activity {
            grew += 1;
            last_activity = activity;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(grew >= 5, "the activity kept growing: {grew}");
    assert!(last_activity > initial_activity, "the activity grew");

    // A second dashboard over the same directory adopts the owner as it is.
    let replacement = app(&repo);
    let (conn, mut inbox) = connected(&replacement).await;
    replacement.command(&conn, Command::GetGoalDrafts).await;
    let listed = frame_matching(
        &mut inbox,
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
    assert!(runs[0]["activity"].as_array().expect("an activity").len() >= last_activity);
    assert_eq!(
        owner_pid_of(&owner_state(&repo, &path).expect("the adopted state")),
        Some(owner_pid)
    );

    let question = frame_matching(
        &mut inbox,
        |frame| frame["type"] == "issuesDraftState" && frame["draft"]["question"].is_object(),
        15000,
    )
    .await;
    let id = question["draft"]["question"]["id"].clone();
    replacement
        .command(
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
    assert_eq!(answered["draft"]["error"], Value::Null);

    replacement
        .command(
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
    assert_eq!(stopped["draft"]["error"], Value::Null);
    assert_eq!(
        owner_state(&repo, &path).expect("the stopped state")["run"]["status"],
        "stopped"
    );
    owner.kill();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_orphan_reaper_never_kills_a_live_goal_draft_owner() {
    let _serial = serial().await;
    let repo = repo_root("reaper");
    let path = write_draft(&repo, "reaper.md", "# Reaper\n\nSTUB-HANG\n");
    write_running_record(&repo, &path, std::process::id(), std::process::id());
    let owner = spawn_owner_process(
        &repo,
        &path,
        &std::env::var("AGENT_COMMAND").expect("the stub agent"),
    );
    let mut claimed_pid = None;
    assert!(
        wait_until(
            || {
                let state = owner_state(&repo, &path);
                claimed_pid = state.as_ref().and_then(owner_pid_of);
                claimed_pid.is_some()
            },
            5000,
        )
        .await
    );
    let owner_pid = claimed_pid.expect("a claimed pid");

    // The record proves a caller started this owner; that caller is dead now,
    // and no dashboard holds a lease.
    let stat = devboard::supervision::process_stat(owner_pid).expect("the owner stat");
    let record = json!({
        "version": 1,
        "pid": owner_pid,
        "argv": devboard::supervision::process_argv(owner_pid).expect("the owner argv"),
        "cwd": repo.display().to_string(),
        "ownerPid": 3_999_999u32,
        "startedAt": devboard::journal::now_iso8601(),
        "startTicks": stat.start_ticks,
        "pgid": stat.pgid,
    });
    let record_path = devboard::supervision::supervision_record_path(&state_dir(), owner_pid);
    std::fs::create_dir_all(record_path.parent().expect("a supervision directory"))
        .expect("a supervision directory");
    std::fs::write(
        &record_path,
        format!("{}\n", serde_json::to_string(&record).expect("record JSON")),
    )
    .expect("a record");
    let _ = std::fs::remove_file(devboard::goal_drafts::goal_draft_lease_path(
        &state_dir(),
        &repo,
    ));

    let report = devboard::workers::watchdog::run_orphan_reaper(
        devboard::workers::watchdog::OrphanReaperRunOptions {
            root: repo.clone(),
            state_dir: Some(state_dir()),
            instances: Some(Vec::new()),
            processes: Some(Vec::new()),
            ..devboard::workers::watchdog::OrphanReaperRunOptions::new(repo.clone())
        },
    );
    assert!(
        !report.killed.contains(&owner_pid),
        "the live owner is not killed: {report:?}"
    );
    assert!(
        !report
            .decisions
            .iter()
            .any(|decision| decision.pid == owner_pid
                && matches!(
                    decision.action,
                    devboard::supervision::ReapAction::Killed
                        | devboard::supervision::ReapAction::WouldKill
                )),
        "no kill is reported for the live owner: {report:?}"
    );
    assert!(
        report
            .decisions
            .iter()
            .any(|decision| decision.pid == owner_pid
                && decision.action == devboard::supervision::ReapAction::Skipped),
        "the run's record made the owner a candidate that was left alone: {report:?}"
    );
    assert!(
        devboard::supervision::live_process(owner_pid),
        "the live owner is still alive"
    );

    devboard::goal_drafts::write_goal_draft_owner_command(
        &devboard::goal_drafts::goal_draft_control_directory(&state_dir(), &repo, &path),
        &devboard::goal_drafts::GoalDraftOwnerCommand::Stop,
    );
    let stopped = wait_until(|| !process_alive(owner_pid), 5000).await;
    assert!(stopped, "the owner ends with Stop");
    let _ = std::fs::remove_file(&record_path);
    owner.kill();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_dead_owner_is_restarted_once_and_a_second_death_is_truthful() {
    let _serial = serial().await;
    let repo = repo_root("restart");
    let path = write_draft(&repo, "restart.md", "# Restart\n\nSTUB-HANG\n");
    let app = app(&repo);
    let (conn, mut inbox) = connected(&app).await;
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
    assert_eq!(running["draft"]["error"], Value::Null);

    let mut first_pid = None;
    assert!(
        wait_until(
            || {
                let state = owner_state(&repo, &path);
                first_pid = state.as_ref().and_then(owner_pid_of);
                first_pid.is_some()
            },
            10000,
        )
        .await
    );
    let first_pid = first_pid.expect("a claimed pid");
    let before = owner_state(&repo, &path).expect("the running state");
    let before_activity: Vec<String> = before["run"]["activity"]
        .as_array()
        .expect("an activity")
        .iter()
        .map(|line| line.as_str().expect("an activity line").to_string())
        .collect();
    let first_peer = before["peer"]["pid"].as_u64();
    while inbox.try_recv().is_ok() {}

    kill_pid(first_pid);
    // The watcher observes owners on its 250 ms cadence and a loaded CI host
    // can delay the replacement's start; the contract is one replacement, not
    // a five-second deadline.
    let window = std::time::Instant::now();
    let mut pids = vec![first_pid];
    let mut last_pid = first_pid;
    while window.elapsed() < Duration::from_millis(15_000) {
        if let Some(pid) = owner_state(&repo, &path).and_then(|state| owner_pid_of(&state)) {
            if pid != last_pid {
                pids.push(pid);
                last_pid = pid;
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        pids.len(),
        2,
        "exactly one new owner within fifteen seconds: {pids:?}"
    );
    let second_pid = pids[1];
    assert!(devboard::supervision::live_process(second_pid));

    let after = owner_state(&repo, &path).expect("the restarted state");
    assert_eq!(after["run"]["status"], "running");
    assert_eq!(owner_pid_of(&after), Some(second_pid));
    let after_activity: Vec<String> = after["run"]["activity"]
        .as_array()
        .expect("an activity")
        .iter()
        .map(|line| line.as_str().expect("an activity line").to_string())
        .collect();
    assert_eq!(
        &after_activity[..before_activity.len()],
        &before_activity[..],
        "the recorded activity stays a prefix"
    );
    let second_peer = after["peer"]["pid"].as_u64();

    let mut restarted_frames = Vec::new();
    tokio::time::sleep(Duration::from_millis(500)).await;
    while let Ok(text) = inbox.try_recv() {
        restarted_frames.push(parse(&text));
    }
    assert!(
        restarted_frames
            .iter()
            .any(|frame| frame["type"] == "issuesDraftState"
                && frame["draft"]["status"] == "running"),
        "the client is told the run is running again: {restarted_frames:?}"
    );
    assert!(
        restarted_frames
            .iter()
            .all(|frame| frame["type"] != "issuesDraftError"),
        "no client start is needed: {restarted_frames:?}"
    );
    assert!(
        restarted_frames.iter().all(
            |frame| frame["type"] != "issuesDraftState" || frame["draft"]["status"] != "failed"
        ),
        "no failure is reported while the restart lives: {restarted_frames:?}"
    );

    kill_pid(second_pid);
    let mut second_death = None;
    let deadline = std::time::Instant::now() + Duration::from_millis(5000);
    while std::time::Instant::now() < deadline {
        let state = owner_state(&repo, &path);
        if state
            .as_ref()
            .is_some_and(|state| state["run"]["status"] == "failed")
        {
            second_death = state;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let second_death = second_death.expect("the second death is recorded within five seconds");
    assert_eq!(
        second_death["run"]["error"],
        "The elaboration owner exited before it finished."
    );
    let settled_owner = owner_pid_of(&second_death);
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let settled = owner_state(&repo, &path).expect("the failed state");
    assert_eq!(settled["run"]["status"], "failed");
    assert_eq!(
        owner_pid_of(&settled),
        settled_owner,
        "no third owner is spawned"
    );

    app.command(&conn, Command::GetGoalDrafts).await;
    let listed = frame_matching(
        &mut inbox,
        |frame| {
            frame["type"] == "issuesDrafts"
                && frame["runs"].is_array()
                && frame["drafts"]
                    .as_array()
                    .is_some_and(|drafts| !drafts.is_empty())
        },
        5000,
    )
    .await;
    assert!(listed["drafts"]
        .as_array()
        .expect("drafts")
        .iter()
        .any(|draft| draft["path"] == json!(path)));
    let runs = listed["runs"].as_array().expect("runs");
    assert_eq!(runs[0]["status"], "failed");

    if let Some(peer) = second_peer {
        kill_pid(peer as u32);
    }
    if let Some(peer) = first_peer {
        kill_pid(peer as u32);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_missing_draft_is_never_restarted() {
    let _serial = serial().await;
    let repo = repo_root("missing-restart");
    let path = ".devboard/goal-proposals/gone.md".to_string();
    let launcher = root().join("missing-launcher.sh");
    let invocations = root().join("missing-launcher.log");
    let _ = std::fs::remove_file(&invocations);
    executable_script(
        &launcher,
        &format!(
            "#!/bin/sh\necho $$ >> {}\nexec sleep 600\n",
            invocations.display()
        ),
    );
    let _restore = use_owner_executable(&launcher);

    // The owner is gone and its claim never arrives; the draft it names is
    // gone too.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("the clock")
        .as_millis() as i64;
    write_running_record_since(
        &repo,
        &path,
        std::process::id(),
        std::process::id(),
        devboard::agent_sessions::iso_from_millis(now - 11_000),
    );

    let app = app(&repo);
    let (conn, mut inbox) = connected(&app).await;
    app.command(&conn, Command::GetGoalDrafts).await;
    let failed = frame_matching(
        &mut inbox,
        |frame| frame["type"] == "issuesDraftState" && frame["draft"]["status"] == "failed",
        5000,
    )
    .await;
    assert_eq!(
        failed["draft"]["error"],
        "No draft at .devboard/goal-proposals/gone.md."
    );
    assert!(!invocations.exists(), "a missing draft starts no owner");
    let state = owner_state(&repo, &path).expect("the failed state");
    assert_eq!(state["run"]["status"], "failed");
    assert_eq!(state["owner"], Value::Null);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_start_that_never_claims_fails_truthfully() {
    let _serial = serial().await;
    let repo = repo_root("never-claims");
    let path = write_draft(&repo, "never.md", "# Never\n\nSTUB-HANG\n");
    let launcher = root().join("never-launcher.sh");
    let invocations = root().join("never-launcher.log");
    let _ = std::fs::remove_file(&invocations);
    executable_script(
        &launcher,
        &format!(
            "#!/bin/sh\necho $$ >> {}\nexec sleep 600\n",
            invocations.display()
        ),
    );
    let _restore = use_owner_executable(&launcher);

    let app = app(&repo);
    let (conn, mut inbox) = connected(&app).await;
    app.command(
        &conn,
        Command::StartGoalDraft {
            path: Some(json!(path)),
        },
    )
    .await;
    let failed = frame_matching(
        &mut inbox,
        |frame| frame["type"] == "issuesDraftState" && frame["draft"]["status"] == "failed",
        40000,
    )
    .await;
    assert_eq!(
        failed["draft"]["error"],
        "The elaboration owner did not start."
    );

    let lines: Vec<String> = std::fs::read_to_string(&invocations)
        .expect("the launcher log")
        .lines()
        .map(str::to_string)
        .collect();
    assert_eq!(lines.len(), 2, "exactly one automatic restart: {lines:?}");
    tokio::time::sleep(Duration::from_millis(2500)).await;
    let again = std::fs::read_to_string(&invocations).expect("the launcher log");
    assert_eq!(
        again.lines().count(),
        2,
        "no third launcher invocation: {again}"
    );
    for pid in lines {
        if let Ok(pid) = pid.parse::<u32>() {
            kill_pid(pid);
        }
    }
}
