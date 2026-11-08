//! Behavior proofs for the Goal-mode lifecycle, its lanes, a manual ADR run,
//! and the implementation reset, driven by the deterministic stub agent.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use devboard::app::{App, Conn};
use devboard::command::Command;
use devboard::config::Config;
use devboard::journal::Journal;
use devboard::providers::SaveProviderInput;
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedReceiver;

/// The tracker and reset tests share the process environment, so they run one
/// at a time.
fn serial() -> &'static tokio::sync::Mutex<()> {
    static LOCK: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));
    &LOCK
}

fn devboard_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the devboard harness directory exists")
}

struct Scratch {
    path: PathBuf,
}

impl Scratch {
    fn new(label: &str) -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock is after the epoch")
            .as_nanos();
        let root = devboard_root().join(".test-tmp");
        std::fs::create_dir_all(&root).expect("scratch root exists");
        let path = root.join(format!(
            "goal-run-{label}-{}-{nanos}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&path).expect("scratch directory exists");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// One local Gitea stub whose open issues mirror a fixture tracker file.
struct Tracker {
    base: String,
    handle: tokio::task::JoinHandle<()>,
}

impl Tracker {
    async fn start(fixture: PathBuf) -> Self {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("a tracker listener");
        let port = listener.local_addr().expect("a tracker address").port();
        let router = Router::new()
            .route("/api/v1/repos/owner/name/issues", get(tracker_issues))
            .with_state(fixture);
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        Self {
            base: format!("http://127.0.0.1:{port}"),
            handle,
        }
    }
}

impl Drop for Tracker {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

async fn tracker_issues(State(fixture): State<PathBuf>) -> Json<Value> {
    let entries: Vec<Value> = std::fs::read_to_string(&fixture)
        .ok()
        .and_then(|source| serde_json::from_str(&source).ok())
        .unwrap_or_default();
    let issues: Vec<Value> = entries
        .iter()
        .filter_map(|entry| {
            let number = entry.get("number")?.as_i64()?;
            let title = entry.get("title")?.as_str()?;
            Some(json!({
                "number": number,
                "title": title,
                "html_url": format!("https://gitea.test/owner/name/issues/{number}"),
                "created_at": "2024-01-02T03:04:05Z",
                "closed_at": Value::Null,
                "state": "open",
                "body": "devboard-epic",
                "labels": [{"name": "epic"}],
            }))
        })
        .collect();
    Json(Value::Array(issues))
}

fn stub_command(scratch: &Scratch, arguments: &[&str]) -> String {
    let log = scratch.path().join("agent.log");
    let mut command = format!(
        "{} acp-stub --log={}",
        env!("CARGO_BIN_EXE_devboard"),
        log.display()
    );
    for argument in arguments {
        command.push(' ');
        command.push_str(argument);
    }
    command
}

fn config_at(scratch: &Scratch, command: String) -> Config {
    let root = scratch.path();
    Config {
        hostname: "127.0.0.1".to_string(),
        port: 0,
        adrs_dir: root.join("adrs"),
        repo_dir: root.to_path_buf(),
        goal_file: root.join("GOAL.md"),
        static_dir: None,
        agent_command: command,
        state_dir: root.join("state"),
        allowed_hosts: Vec::new(),
        feedback: None,
    }
}

async fn app_with(scratch: &Scratch, command: String) -> Arc<App> {
    std::fs::create_dir_all(scratch.path().join("adrs")).expect("adrs exist");
    std::env::set_var("DEVBOARD_OPENCODE_GO_USAGE_BASE_URL", "http://127.0.0.1:1");
    std::env::set_var("DEVBOARD_OPENROUTER_USAGE_BASE_URL", "http://127.0.0.1:1");
    let config = config_at(scratch, command);
    let journal = Journal::open(&config.state_dir, &config.repo_dir, 0);
    let app = App::new(config, journal);
    app.providers
        .save(SaveProviderInput {
            id: None,
            provider: Some(json!("opencode-go")),
            label: Some(json!("Fixture subscription")),
            key: Some(json!("fixture-key")),
        })
        .await
        .expect("the fixture subscription saves");
    app
}

/// A repository the lifecycle accepts: a git checkout, a goal, and one
/// managed skill.
fn prepare_repository(scratch: &Scratch, remote: Option<&str>) {
    let root = scratch.path();
    std::fs::create_dir_all(root.join("adrs")).expect("adrs exist");
    let status = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["init", "-q"])
        .status()
        .expect("git init");
    assert!(status.success(), "the fixture repository initializes");
    if let Some(remote) = remote {
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["remote", "add", "origin", remote])
            .status()
            .expect("git remote add");
        assert!(status.success(), "the fixture origin exists");
    }
    std::fs::write(root.join("GOAL.md"), "# The goal\n\nShip the fixture.\n")
        .expect("goal written");
    let skill = root.join(".omp/skills/fixture-skill");
    std::fs::create_dir_all(&skill).expect("skill directory");
    std::fs::write(
        skill.join("SKILL.md"),
        "---\nname: fixture-skill\ndescription: A fixture skill\nmetadata:\n  \
devboard-managed: \"true\"\n  devboard-family: prepare\n---\n\nBody\n",
    )
    .expect("skill written");
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

async fn collect_until(
    inbox: &mut UnboundedReceiver<String>,
    predicate: impl Fn(&Value) -> bool,
    millis: u64,
) -> Vec<Value> {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(millis);
    let mut frames = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        assert!(!remaining.is_zero(), "no frame matched before the deadline");
        let text = tokio::time::timeout(remaining, inbox.recv())
            .await
            .expect("a frame before the deadline")
            .expect("a live frame channel");
        let frame = parse(&text);
        let matched = predicate(&frame);
        frames.push(frame);
        if matched {
            return frames;
        }
    }
}

async fn until(predicate: impl Fn() -> bool, millis: u64) {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(millis);
    while !predicate() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(predicate(), "the condition held before the deadline");
}

fn log_lines(scratch: &Scratch, prefix: &str) -> Vec<String> {
    let source = std::fs::read_to_string(scratch.path().join("agent.log")).unwrap_or_default();
    source
        .split('\n')
        .filter(|line| line.starts_with(prefix))
        .map(|line| line[prefix.len()..].to_string())
        .collect()
}

fn state_value(scratch: &Scratch) -> Value {
    let path = devboard::state::state_file(&scratch.path().join("state"), scratch.path());
    let source = std::fs::read_to_string(path).expect("the state file exists");
    let envelope: Value = serde_json::from_str(&source).expect("valid state JSON");
    envelope["state"].clone()
}

fn has_frame(frames: &[Value], predicate: impl Fn(&Value) -> bool) -> bool {
    frames.iter().any(predicate)
}

#[tokio::test]
async fn lifecycle_starts_lanes_relays_activity_and_finishes() {
    let _guard = serial().lock().await;
    let scratch = Scratch::new("lifecycle");
    let tracker_file = scratch.path().join("tracker.json");
    std::fs::write(
        &tracker_file,
        serde_json::to_string(&json!([
            {"number": 7, "title": "Epic seven", "url": "https://gitea.test/7"}
        ]))
        .expect("tracker JSON"),
    )
    .expect("tracker written");
    let tracker = Tracker::start(tracker_file.clone()).await;
    std::env::set_var("DEVBOARD_GITEA_URL", &tracker.base);
    prepare_repository(&scratch, Some(&format!("{}/owner/name", tracker.base)));

    let command = stub_command(
        &scratch,
        &[&format!("--fixture-tracker={}", tracker_file.display())],
    );
    let app = app_with(&scratch, command).await;
    let (conn, mut inbox) = connected(&app).await;

    app.command(&conn, Command::StartLifecycle).await;

    let frames = collect_until(
        &mut inbox,
        |frame| frame["type"] == "lifecycleState" && frame["stage"] == "finished",
        25_000,
    )
    .await;

    assert!(
        has_frame(&frames, |frame| {
            frame["type"] == "lifecycleState" && frame["stage"] == "epic" && frame["pass"] == 1
        }),
        "the run is reported active before the tracker answers: {frames:?}"
    );
    assert!(
        has_frame(&frames, |frame| {
            frame["type"] == "runStarted"
                && frame["kind"] == "implementation"
                && frame["file"] == ""
                && frame["title"] == "Epic seven"
                && frame["action"] == "implementing"
        }),
        "the epic lane starts: {frames:?}"
    );
    assert!(
        has_frame(&frames, |frame| {
            frame["type"] == "activity" && frame["text"] == "Working on epic 7"
        }),
        "the lane's activity is relayed: {frames:?}"
    );
    assert!(
        has_frame(&frames, |frame| {
            frame["type"] == "laneState"
                && frame["lanes"].as_array().is_some_and(|lanes| {
                    lanes.iter().any(|lane| {
                        lane["kind"] == "implementation"
                            && lane["epic"]["number"] == 7
                            && lane["status"] == "running"
                    })
                })
                && frame["openEpics"] == 1
        }),
        "the running lane and its open epic are published: {frames:?}"
    );
    assert!(
        has_frame(&frames, |frame| {
            frame["type"] == "runStopped"
                && frame["kind"].is_null()
                && frame["resolved"] == true
                && frame["status"] == "closed"
        }),
        "the closed epic lane reports its outcome: {frames:?}"
    );
    assert!(
        has_frame(&frames, |frame| {
            frame["type"] == "runStarted" && frame["kind"] == "generation"
        }) && has_frame(&frames, |frame| {
            frame["type"] == "activity" && frame["text"] == "Choosing the next epics"
        }),
        "the refill generation pass runs: {frames:?}"
    );
    assert!(
        has_frame(&frames, |frame| {
            frame["type"] == "lifecycleState" && frame["stage"] == "epic" && frame["pass"] == 2
        }),
        "a closed epic advances the pass: {frames:?}"
    );

    let prompts = log_lines(&scratch, "prompt ");
    assert!(prompts.contains(&"/implement-next-epic 7".to_string()));
    assert!(prompts.contains(&"/epic-next".to_string()));

    until(
        || {
            let state = state_value(&scratch);
            state["lifecycleRunning"] == false && state["lifecycle"]["stage"] == "finished"
        },
        5_000,
    )
    .await;
    let state = state_value(&scratch);
    assert_eq!(state["lastLifecycle"]["stage"], "finished");
    assert!(
        state["lanes"]
            .as_array()
            .is_some_and(|lanes| lanes.iter().all(|lane| lane["status"] == "closed")),
        "every lane is closed: {state:?}"
    );
}

#[tokio::test]
async fn pause_holds_and_resume_continues_the_lifecycle() {
    let _guard = serial().lock().await;
    let scratch = Scratch::new("pause");
    let tracker_file = scratch.path().join("tracker.json");
    std::fs::write(
        &tracker_file,
        serde_json::to_string(&json!([
            {"number": 11, "title": "Epic eleven", "url": "https://gitea.test/11"}
        ]))
        .expect("tracker JSON"),
    )
    .expect("tracker written");
    let tracker = Tracker::start(tracker_file.clone()).await;
    std::env::set_var("DEVBOARD_GITEA_URL", &tracker.base);
    prepare_repository(&scratch, Some(&format!("{}/owner/name", tracker.base)));

    let command = stub_command(
        &scratch,
        &[
            &format!("--fixture-tracker={}", tracker_file.display()),
            "--lane-delay-ms=1200",
        ],
    );
    let app = app_with(&scratch, command).await;
    let (conn, mut inbox) = connected(&app).await;

    app.command(&conn, Command::StartLifecycle).await;
    frame_matching(
        &mut inbox,
        |frame| frame["type"] == "runStarted" && frame["kind"] == "implementation",
        10_000,
    )
    .await;

    app.command(&conn, Command::PauseLifecycle).await;
    let paused = frame_matching(
        &mut inbox,
        |frame| frame["type"] == "lifecycleState" && frame["paused"] == true,
        5_000,
    )
    .await;
    assert_eq!(paused["stage"], "implementation");
    let lanes = frame_matching(
        &mut inbox,
        |frame| {
            frame["type"] == "laneState"
                && frame["lanes"]
                    .as_array()
                    .is_some_and(|lanes| lanes.iter().any(|lane| lane["status"] == "paused"))
        },
        5_000,
    )
    .await;
    assert!(lanes["lanes"]
        .as_array()
        .is_some_and(|lanes| !lanes.is_empty()));

    app.command(&conn, Command::ResumeLifecycle).await;
    frame_matching(
        &mut inbox,
        |frame| frame["type"] == "lifecycleState" && frame["paused"] == false,
        5_000,
    )
    .await;
    frame_matching(
        &mut inbox,
        |frame| {
            frame["type"] == "laneState"
                && frame["lanes"]
                    .as_array()
                    .is_some_and(|lanes| lanes.iter().any(|lane| lane["status"] == "running"))
        },
        5_000,
    )
    .await;

    collect_until(
        &mut inbox,
        |frame| frame["type"] == "lifecycleState" && frame["stage"] == "finished",
        30_000,
    )
    .await;
    until(|| state_value(&scratch)["lifecycleRunning"] == false, 5_000).await;
}

#[tokio::test]
async fn stop_refuses_while_idle_and_ends_a_running_lifecycle() {
    let _guard = serial().lock().await;
    let scratch = Scratch::new("stop");
    let tracker_file = scratch.path().join("tracker.json");
    std::fs::write(
        &tracker_file,
        serde_json::to_string(&json!([
            {"number": 13, "title": "Epic thirteen", "url": "https://gitea.test/13"}
        ]))
        .expect("tracker JSON"),
    )
    .expect("tracker written");
    let tracker = Tracker::start(tracker_file.clone()).await;
    std::env::set_var("DEVBOARD_GITEA_URL", &tracker.base);
    prepare_repository(&scratch, Some(&format!("{}/owner/name", tracker.base)));

    let command = stub_command(
        &scratch,
        &[
            &format!("--fixture-tracker={}", tracker_file.display()),
            "--lane-delay-ms=1500",
        ],
    );
    let app = app_with(&scratch, command).await;
    let (conn, mut inbox) = connected(&app).await;

    app.command(&conn, Command::StopLifecycle).await;
    let refused = frame_matching(&mut inbox, |frame| frame["type"] == "error", 5_000).await;
    assert_eq!(refused["message"], "No lifecycle run is active.");

    app.command(&conn, Command::StartLifecycle).await;
    frame_matching(
        &mut inbox,
        |frame| frame["type"] == "runStarted" && frame["kind"] == "implementation",
        10_000,
    )
    .await;

    app.command(&conn, Command::StopLifecycle).await;
    let frames = collect_until(
        &mut inbox,
        |frame| frame["type"] == "lifecycleState" && frame["stage"] == "goal",
        5_000,
    )
    .await;
    let stopped = frames.last().expect("the goal stage frame");
    assert_eq!(stopped["paused"], false);
    let lanes = frames
        .iter()
        .find(|frame| frame["type"] == "laneState" && frame["runningLanes"] == 0)
        .expect("the lane snapshot after the stop");
    assert!(
        lanes["lanes"]
            .as_array()
            .is_some_and(|lanes| lanes.iter().any(|lane| lane["status"] == "failed")),
        "{lanes:?}"
    );

    until(
        || {
            let state = state_value(&scratch);
            state["lifecycleRunning"] == false && state["lifecycle"]["stage"] == "goal"
        },
        5_000,
    )
    .await;
}

#[tokio::test]
async fn a_lane_question_is_answered_through_its_lane() {
    let _guard = serial().lock().await;
    let scratch = Scratch::new("lane-question");
    let tracker_file = scratch.path().join("tracker.json");
    std::fs::write(
        &tracker_file,
        serde_json::to_string(&json!([
            {"number": 31, "title": "Epic thirty-one", "url": "https://gitea.test/31"}
        ]))
        .expect("tracker JSON"),
    )
    .expect("tracker written");
    let tracker = Tracker::start(tracker_file.clone()).await;
    std::env::set_var("DEVBOARD_GITEA_URL", &tracker.base);
    prepare_repository(&scratch, Some(&format!("{}/owner/name", tracker.base)));

    let command = stub_command(
        &scratch,
        &[
            &format!("--fixture-tracker={}", tracker_file.display()),
            "--question-epic=31",
        ],
    );
    let app = app_with(&scratch, command).await;
    let (conn, mut inbox) = connected(&app).await;

    app.command(&conn, Command::StartLifecycle).await;
    let question = frame_matching(
        &mut inbox,
        |frame| frame["type"] == "question" && frame["lane"].is_string(),
        15_000,
    )
    .await;
    assert_eq!(question["message"], "Choose an answer");
    let lane_id = question["lane"].as_str().expect("a lane id").to_string();

    app.command(
        &conn,
        Command::Answer {
            id: Some(question["id"].clone()),
            value: Some(json!("Alpha")),
            lane: Some(json!(lane_id.clone())),
        },
    )
    .await;
    frame_matching(
        &mut inbox,
        |frame| {
            frame["type"] == "activity"
                && frame["text"] == "Answer received: Alpha"
                && frame["lane"].is_string()
        },
        10_000,
    )
    .await;
    let stopped = frame_matching(
        &mut inbox,
        |frame| frame["type"] == "runStopped" && frame["lane"] == Value::String(lane_id.clone()),
        10_000,
    )
    .await;
    assert_eq!(stopped["resolved"], true);
    assert_eq!(stopped["status"], "closed");
    collect_until(
        &mut inbox,
        |frame| frame["type"] == "lifecycleState" && frame["stage"] == "finished",
        30_000,
    )
    .await;
}

#[tokio::test]
async fn replay_rebuilds_the_running_lifecycle_and_its_lanes() {
    let _guard = serial().lock().await;
    let scratch = Scratch::new("replay");
    let tracker_file = scratch.path().join("tracker.json");
    std::fs::write(
        &tracker_file,
        serde_json::to_string(&json!([
            {"number": 21, "title": "Epic twenty-one", "url": "https://gitea.test/21"}
        ]))
        .expect("tracker JSON"),
    )
    .expect("tracker written");
    let tracker = Tracker::start(tracker_file.clone()).await;
    std::env::set_var("DEVBOARD_GITEA_URL", &tracker.base);
    prepare_repository(&scratch, Some(&format!("{}/owner/name", tracker.base)));

    let command = stub_command(
        &scratch,
        &[
            &format!("--fixture-tracker={}", tracker_file.display()),
            "--lane-delay-ms=3000",
        ],
    );
    let app = app_with(&scratch, command).await;
    let (conn, mut inbox) = connected(&app).await;

    app.command(&conn, Command::StartLifecycle).await;
    frame_matching(
        &mut inbox,
        |frame| frame["type"] == "runStarted" && frame["kind"] == "implementation",
        10_000,
    )
    .await;

    let (conn2, mut inbox2) = connected(&app).await;
    app.open(&conn2).await;
    let frames = collect_until(&mut inbox2, |frame| frame["type"] == "laneState", 5_000).await;
    assert!(
        has_frame(&frames, |frame| {
            frame["type"] == "lifecycleState" && frame["stage"] == "implementation"
        }),
        "the run's stage is replayed: {frames:?}"
    );
    let lanes = frames.last().expect("the lane snapshot");
    assert_eq!(lanes["openEpics"], 1);
    assert!(
        lanes["lanes"]
            .as_array()
            .is_some_and(|lanes| lanes.iter().any(|lane| {
                lane["kind"] == "implementation"
                    && lane["epic"]["number"] == 21
                    && lane["status"] == "running"
            })),
        "the running lane is replayed: {lanes:?}"
    );

    app.command(&conn, Command::StopLifecycle).await;
    until(|| state_value(&scratch)["lifecycleRunning"] == false, 5_000).await;
}

#[tokio::test]
async fn a_manual_run_resolves_a_pending_record_with_an_answer() {
    let _guard = serial().lock().await;
    let scratch = Scratch::new("manual");
    prepare_repository(&scratch, None);
    std::fs::write(
        scratch.path().join("adrs/a.md"),
        "---\ntitle: Adopt the fixture decision\nstatus: proposed\n---\n\n## Decision\n\nUse it.\n",
    )
    .expect("record written");

    let command = stub_command(&scratch, &[]);
    let app = app_with(&scratch, command).await;
    let (conn, mut inbox) = connected(&app).await;

    app.command(&conn, Command::StartRun { file: None }).await;

    let started = frame_matching(&mut inbox, |frame| frame["type"] == "runStarted", 10_000).await;
    assert_eq!(started["manual"], true);
    assert_eq!(started["file"], "a.md");
    assert_eq!(started["title"], "Adopt the fixture decision");
    assert_eq!(started["action"], "resolving");
    frame_matching(
        &mut inbox,
        |frame| frame["type"] == "activity" && frame["text"] == "Inspecting a.md",
        5_000,
    )
    .await;
    let question = frame_matching(&mut inbox, |frame| frame["type"] == "question", 5_000).await;
    assert_eq!(question["message"], "Choose an answer");
    assert_eq!(question["options"][0]["label"], "Alpha");

    app.command(
        &conn,
        Command::Answer {
            id: Some(question["id"].clone()),
            value: Some(json!("Alpha")),
            lane: None,
        },
    )
    .await;
    frame_matching(
        &mut inbox,
        |frame| frame["type"] == "activity" && frame["text"] == "Answer received: Alpha",
        5_000,
    )
    .await;

    let stopped = frame_matching(&mut inbox, |frame| frame["type"] == "runStopped", 10_000).await;
    assert_eq!(stopped["file"], "a.md");
    assert_eq!(stopped["resolved"], true);
    assert_eq!(stopped["status"], "Accepted");
    let records = frame_matching(&mut inbox, |frame| frame["type"] == "records", 5_000).await;
    assert_eq!(records["records"][0]["file"], "a.md");
    assert_eq!(records["records"][0]["status"], "Accepted");
    assert_eq!(records["records"][0]["pending"], false);
    assert_eq!(records["next"], Value::Null);

    assert_eq!(log_lines(&scratch, "answer "), vec!["Alpha".to_string()]);
    assert!(log_lines(&scratch, "prompt ")
        .iter()
        .any(|line| line.starts_with("/adr-resolve ") && line.ends_with("a.md")));
    until(
        || {
            let state = state_value(&scratch);
            state["manualRun"] == Value::Null && state["manualSequencing"] == false
        },
        5_000,
    )
    .await;
}

#[tokio::test]
async fn a_reset_refuses_when_repo_dir_is_not_the_git_top_level() {
    let _guard = serial().lock().await;
    let scratch = Scratch::new("reset");
    std::fs::write(scratch.path().join("GOAL.md"), "# The goal\n").expect("goal written");

    let command = stub_command(&scratch, &[]);
    let app = app_with(&scratch, command).await;
    let (conn, mut inbox) = connected(&app).await;

    app.command(&conn, Command::ResetImplementation).await;

    let started = frame_matching(
        &mut inbox,
        |frame| frame["type"] == "implementationResetStarted",
        5_000,
    )
    .await;
    assert_eq!(started, json!({"type": "implementationResetStarted"}));
    let error = frame_matching(&mut inbox, |frame| frame["type"] == "error", 10_000).await;
    let message = error["message"].as_str().expect("an error message");
    assert!(
        message.starts_with("Reset refused: REPO_DIR is not the repository top level."),
        "{message}"
    );
    let stopped = frame_matching(
        &mut inbox,
        |frame| frame["type"] == "implementationResetStopped",
        5_000,
    )
    .await;
    assert_eq!(stopped["completed"], false);
    assert_eq!(state_value(&scratch)["resetActive"], false);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reset_refuses_every_mutating_command_and_answers_reads() {
    let _serial = serial().lock().await;
    let scratch = Scratch::new("reset-gate");
    prepare_repository(&scratch, None);
    let app = App::new(
        config_at(&scratch, format!("{} --goal", stub_command(&scratch, &[]))),
        Journal::open(&scratch.path().join("state"), scratch.path(), 0),
    );
    let (conn, mut inbox) = connected(&app).await;
    devboard::goal_run::set_reset_active(&app, true);

    app.command(&conn, Command::GetGoal).await;
    let frame: Value = serde_json::from_str(&inbox.recv().await.expect("a frame")).expect("JSON");
    assert_eq!(frame["type"], "goal");

    app.command(&conn, Command::StartIssues).await;
    let mut refused = false;
    while let Ok(Some(text)) = tokio::time::timeout(Duration::from_millis(500), inbox.recv()).await
    {
        let frame: Value = serde_json::from_str(&text).expect("JSON");
        if frame["type"] == "error" {
            assert_eq!(frame["message"], "An implementation reset is active.");
            refused = true;
            break;
        }
    }
    assert!(refused, "a mutating command is refused during the reset");
}
