//! Behavior proofs for goal authoring, driven by the deterministic stub agent.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use devboard::app::{App, Conn};
use devboard::config::Config;
use devboard::journal::Journal;
use devboard::protocol::Command;
use devboard::providers::SaveProviderInput;
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedReceiver;

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
            "goal-authoring-{label}-{}-{nanos}-{}",
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
        addr_dir: root.join("adrs"),
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
    // The provider usage endpoints never leave the machine: an unreachable
    // local port reports unknown usage, which keeps a subscription eligible
    // and makes the test independent of the network.
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

async fn connected(app: &Arc<App>) -> (Conn, UnboundedReceiver<String>) {
    let (outbox, inbox) = tokio::sync::mpsc::unbounded_channel();
    let conn = Conn::new(outbox);
    app.register(conn.clone()).await;
    (conn, inbox)
}

fn parse(text: &str) -> Value {
    serde_json::from_str(text).expect("a JSON frame")
}

async fn next_frame(inbox: &mut UnboundedReceiver<String>, millis: u64) -> Value {
    let text = tokio::time::timeout(Duration::from_millis(millis), inbox.recv())
        .await
        .expect("a frame before the deadline")
        .expect("a live frame channel");
    parse(&text)
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
) -> (Value, Vec<Value>) {
    let mut frames = Vec::new();
    loop {
        let frame = next_frame(inbox, millis).await;
        let matched = predicate(&frame);
        frames.push(frame.clone());
        if matched {
            return (frame, frames);
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn creation_relays_activity_and_a_question_and_reports_the_written_goal() {
    let scratch = Scratch::new("creation");
    let goal = scratch.path().join("GOAL.md");
    let command = stub_command(
        &scratch,
        &["--create-goal", &format!("--goal={}", goal.display())],
    );
    let app = app_with(&scratch, command).await;
    let (conn, mut inbox) = connected(&app).await;

    app.command(&conn, Command::CreateGoal).await;

    let started = frame_matching(
        &mut inbox,
        |frame| frame["type"] == "goalCreationStarted",
        5_000,
    )
    .await;
    assert_eq!(started, json!({"type": "goalCreationStarted"}));
    frame_matching(
        &mut inbox,
        |frame| frame["type"] == "activity" && frame["text"] == "Creating the goal",
        5_000,
    )
    .await;
    let question = frame_matching(&mut inbox, |frame| frame["type"] == "question", 5_000).await;
    assert_eq!(question["message"], "Choose an answer");
    assert_eq!(question["options"][0]["label"], "Alpha");
    assert_eq!(question["options"][0]["recommended"], true);
    assert_eq!(
        log_lines(&scratch, "prompt "),
        vec!["/goal-outcome".to_string()]
    );
    assert_eq!(log_lines(&scratch, "spawn ").len(), 1);

    // A client that connects mid-turn receives the start, the activity so far,
    // and the pending question before any reply of its own.
    let (late, mut late_inbox) = connected(&app).await;
    app.open(&late).await;
    let replay_started = frame_matching(
        &mut late_inbox,
        |frame| frame["type"] == "goalCreationStarted",
        5_000,
    )
    .await;
    assert_eq!(replay_started, json!({"type": "goalCreationStarted"}));
    frame_matching(
        &mut late_inbox,
        |frame| frame["type"] == "activity" && frame["text"] == "Creating the goal",
        5_000,
    )
    .await;
    let replayed_question =
        frame_matching(&mut late_inbox, |frame| frame["type"] == "question", 5_000).await;
    assert_eq!(replayed_question["id"], question["id"]);

    app.command(
        &conn,
        Command::Answer {
            id: Some(question["id"].clone()),
            value: Some(json!("Alpha")),
            lane: None,
        },
    )
    .await;

    let (stopped, after_answer) = collect_until(
        &mut inbox,
        |frame| frame["type"] == "goalCreationStopped",
        10_000,
    )
    .await;
    assert_eq!(
        stopped,
        json!({
            "type": "goalCreationStopped",
            "completed": true,
            "text": "# Created goal\n\nThe agent wrote this.",
        })
    );
    assert_eq!(
        std::fs::read_to_string(&goal).expect("the goal exists"),
        "# Created goal\n\nThe agent wrote this."
    );
    assert_eq!(log_lines(&scratch, "answer "), vec!["Alpha".to_string()]);

    let activities: Vec<String> = after_answer
        .iter()
        .filter(|frame| frame["type"] == "activity")
        .filter_map(|frame| frame["text"].as_str().map(str::to_string))
        .collect();
    assert_eq!(
        activities,
        vec![
            "Answer received: Alpha".to_string(),
            "Created the goal".to_string(),
        ]
    );
    assert_eq!(log_lines(&scratch, "spawn ").len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revision_carries_guidance_and_reports_the_revised_goal() {
    let scratch = Scratch::new("revision");
    let goal = scratch.path().join("GOAL.md");
    std::fs::write(&goal, "# Original goal\n").expect("the original goal");
    let command = stub_command(
        &scratch,
        &["--revise-goal", &format!("--goal={}", goal.display())],
    );
    let app = app_with(&scratch, command).await;
    let (conn, mut inbox) = connected(&app).await;

    app.command(
        &conn,
        Command::ReviseGoal {
            request: Some(json!("Tighten the goal")),
        },
    )
    .await;

    assert_eq!(
        frame_matching(
            &mut inbox,
            |frame| frame["type"] == "goalRevisionStarted",
            5_000
        )
        .await,
        json!({"type": "goalRevisionStarted"})
    );
    frame_matching(
        &mut inbox,
        |frame| frame["type"] == "activity" && frame["text"] == "Revising the goal",
        5_000,
    )
    .await;
    let question = frame_matching(&mut inbox, |frame| frame["type"] == "question", 5_000).await;

    // A second revision is refused while this one is live.
    app.command(&conn, Command::ReviseGoal { request: None })
        .await;
    let refusal = frame_matching(&mut inbox, |frame| frame["type"] == "error", 5_000).await;
    assert_eq!(refusal["message"], "A goal revision is already active.");

    app.command(
        &conn,
        Command::Answer {
            id: Some(question["id"].clone()),
            value: Some(json!("Beta")),
            lane: None,
        },
    )
    .await;

    let (stopped, after_answer) = collect_until(
        &mut inbox,
        |frame| frame["type"] == "goalRevisionStopped",
        10_000,
    )
    .await;
    assert_eq!(
        stopped,
        json!({
            "type": "goalRevisionStopped",
            "completed": true,
            "text": "# Revised goal\n\nThe agent rewrote this.",
        })
    );
    assert_eq!(
        std::fs::read_to_string(&goal).expect("the goal exists"),
        "# Revised goal\n\nThe agent rewrote this."
    );
    let activities: Vec<String> = after_answer
        .iter()
        .filter(|frame| frame["type"] == "activity")
        .filter_map(|frame| frame["text"].as_str().map(str::to_string))
        .collect();
    assert_eq!(
        activities,
        vec![
            "Answer received: Beta".to_string(),
            "Revised the goal".to_string(),
        ]
    );
    let log = std::fs::read_to_string(scratch.path().join("agent.log")).expect("the log");
    assert!(log.contains("Guidance: Tighten the goal"));
    assert_eq!(log_lines(&scratch, "spawn ").len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn preparation_writes_skills_and_the_delete_command_refuses_every_other_owner() {
    let scratch = Scratch::new("skills");
    std::fs::write(scratch.path().join("GOAL.md"), "# Fixture goal\n").expect("the goal");
    let command = stub_command(&scratch, &["--prepare-skills", "--questions=1"]);
    let app = app_with(&scratch, command).await;
    let (conn, mut inbox) = connected(&app).await;

    app.command(&conn, Command::PrepareSkills).await;

    assert_eq!(
        frame_matching(
            &mut inbox,
            |frame| frame["type"] == "skillsPreparationStarted",
            5_000
        )
        .await,
        json!({"type": "skillsPreparationStarted"})
    );
    frame_matching(
        &mut inbox,
        |frame| {
            frame["type"] == "activity"
                && frame["text"]
                    .as_str()
                    .is_some_and(|text| text.contains("Researching public standards"))
        },
        5_000,
    )
    .await;
    let question = frame_matching(&mut inbox, |frame| frame["type"] == "question", 5_000).await;

    // A creation is refused while the preparation owns the skills tree.
    app.command(&conn, Command::CreateGoal).await;
    let refusal = frame_matching(&mut inbox, |frame| frame["type"] == "error", 5_000).await;
    assert_eq!(refusal["message"], "A skills preparation is active.");

    let (late, mut late_inbox) = connected(&app).await;
    app.open(&late).await;
    frame_matching(
        &mut late_inbox,
        |frame| frame["type"] == "skillsPreparationStarted",
        5_000,
    )
    .await;
    let replayed =
        frame_matching(&mut late_inbox, |frame| frame["type"] == "question", 5_000).await;
    assert_eq!(replayed["id"], question["id"]);

    app.command(
        &late,
        Command::Answer {
            id: Some(replayed["id"].clone()),
            value: Some(json!("Alpha")),
            lane: None,
        },
    )
    .await;

    let (stopped, after_answer) = collect_until(
        &mut inbox,
        |frame| frame["type"] == "skillsPreparationStopped",
        10_000,
    )
    .await;
    assert_eq!(stopped["completed"], true);
    let activities: Vec<String> = after_answer
        .iter()
        .filter(|frame| frame["type"] == "activity")
        .filter_map(|frame| frame["text"].as_str().map(str::to_string))
        .collect();
    assert!(activities.contains(&"Answer received: Alpha".to_string()));
    assert!(activities
        .iter()
        .any(|text| text.contains("Reviewed every installed skill")));
    assert_eq!(stopped["contradictions"], json!([]));
    let names: Vec<String> = stopped["skills"]
        .as_array()
        .expect("skill rows")
        .iter()
        .map(|row| row["name"].as_str().unwrap_or_default().to_string())
        .collect();
    assert!(names.contains(&"dependency-direction".to_string()));
    assert!(names.contains(&"cohesive-units".to_string()));
    assert!(names.contains(&"behavior-first-testing".to_string()));
    let skills_dir = scratch.path().join(".omp").join("skills");
    assert!(skills_dir
        .join("dependency-direction")
        .join("SKILL.md")
        .is_file());
    assert_eq!(
        log_lines(&scratch, "prompt "),
        vec!["/prepare-skills".to_string()]
    );

    app.command(&conn, Command::GetSkills).await;
    let state = frame_matching(&mut inbox, |frame| frame["type"] == "skillsState", 5_000).await;
    let live: Vec<String> = state["skills"]
        .as_array()
        .expect("skill rows")
        .iter()
        .map(|row| row["name"].as_str().unwrap_or_default().to_string())
        .collect();
    assert_eq!(live, {
        let mut sorted = names.clone();
        sorted.sort();
        sorted
    });
    assert_eq!(state["contradictions"], json!([]));

    app.command(
        &conn,
        Command::DeleteSkill {
            name: Some(json!("dependency-direction")),
        },
    )
    .await;
    let after = frame_matching(&mut inbox, |frame| frame["type"] == "skillsState", 5_000).await;
    let remaining: Vec<String> = after["skills"]
        .as_array()
        .expect("skill rows")
        .iter()
        .map(|row| row["name"].as_str().unwrap_or_default().to_string())
        .collect();
    assert!(!remaining.contains(&"dependency-direction".to_string()));
    frame_matching(
        &mut inbox,
        |frame| frame["type"] == "installedSkills",
        5_000,
    )
    .await;
    assert!(!skills_dir.join("dependency-direction").exists());

    app.command(
        &conn,
        Command::DeleteSkill {
            name: Some(json!("../dependency-direction")),
        },
    )
    .await;
    let invalid = frame_matching(&mut inbox, |frame| frame["type"] == "error", 5_000).await;
    assert_eq!(invalid["message"], "Choose a prepared skill to delete.");
    frame_matching(
        &mut inbox,
        |frame| frame["type"] == "installedSkills",
        5_000,
    )
    .await;

    app.command(
        &conn,
        Command::DeleteSkill {
            name: Some(json!("missing-skill")),
        },
    )
    .await;
    let missing = frame_matching(&mut inbox, |frame| frame["type"] == "error", 5_000).await;
    assert_eq!(
        missing["message"],
        "No prepared skill named \"missing-skill\" is installed."
    );
    until(
        || skills_dir.join("cohesive-units").join("SKILL.md").is_file(),
        2_000,
    )
    .await;
}
