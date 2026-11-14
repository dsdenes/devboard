//! Behavior proofs for goal authoring, driven by the deterministic stub agent.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use devboard::app::{App, Conn, ModeGate};
use devboard::command::Command;
use devboard::config::Config;
use devboard::journal::Journal;
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
    app_with_goal(scratch, command, scratch.path().join("GOAL.md")).await
}

async fn app_with_goal(scratch: &Scratch, command: String, goal_file: PathBuf) -> Arc<App> {
    std::fs::create_dir_all(scratch.path().join("adrs")).expect("adrs exist");
    // The provider usage endpoints never leave the machine: an unreachable
    // local port reports unknown usage, which keeps a subscription eligible
    // and makes the test independent of the network.
    std::env::set_var("DEVBOARD_OPENCODE_GO_USAGE_BASE_URL", "http://127.0.0.1:1");
    std::env::set_var("DEVBOARD_OPENROUTER_USAGE_BASE_URL", "http://127.0.0.1:1");
    let mut config = config_at(scratch, command);
    config.goal_file = goal_file;
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
    // The replayed snapshot carries the question it still holds, so a poll that
    // follows an accepted answer can revoke the prompt the page kept.
    assert_eq!(replay_started["type"], "goalCreationStarted");
    assert_eq!(replay_started["question"]["id"], question["id"]);
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

    // The accepted answer is the only thing that clears the prompt, and it
    // names the question so a page can revoke exactly that one.
    assert!(
        after_answer
            .iter()
            .any(|frame| frame["type"] == "questionCleared"
                && frame["id"] == question["id"]
                && frame.get("lane").is_none()),
        "the accepted answer clears the creation's question: {after_answer:?}"
    );

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
        vec![format!(
            "/prepare-skills {}",
            scratch.path().join("GOAL.md").display()
        )]
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

/// With a non-default `GOAL_FILE`, preparation reads the path it names and the
/// peer is told that same path.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn preparation_reads_the_configured_goal_file() {
    let scratch = Scratch::new("skills-configured-goal");
    let goal = scratch.path().join("docs").join("GOAL.md");
    std::fs::create_dir_all(goal.parent().expect("the goal directory"))
        .expect("the goal directory exists");
    std::fs::write(&goal, "# Fixture goal\n").expect("the goal");
    assert!(!scratch.path().join("GOAL.md").exists());
    let command = stub_command(&scratch, &["--prepare-skills"]);
    let app = app_with_goal(&scratch, command, goal.clone()).await;
    let (conn, mut inbox) = connected(&app).await;

    app.command(&conn, Command::PrepareSkills).await;

    frame_matching(
        &mut inbox,
        |frame| frame["type"] == "skillsPreparationStarted",
        5_000,
    )
    .await;
    let stopped = frame_matching(
        &mut inbox,
        |frame| frame["type"] == "skillsPreparationStopped",
        10_000,
    )
    .await;
    assert_eq!(stopped["completed"], true);
    assert_eq!(
        log_lines(&scratch, "prompt "),
        vec![format!("/prepare-skills {}", goal.display())]
    );
    assert_eq!(log_lines(&scratch, "prepared"), vec!["".to_string()]);
}

/// A configured goal path with no document refuses the preparation and starts
/// no peer, even when `<repo>/GOAL.md` holds a goal.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn preparation_refuses_when_the_configured_goal_is_absent() {
    let scratch = Scratch::new("skills-absent-goal");
    std::fs::write(scratch.path().join("GOAL.md"), "# Repo goal\n").expect("the repository goal");
    let goal = scratch.path().join("docs").join("GOAL.md");
    let command = stub_command(&scratch, &["--prepare-skills"]);
    let app = app_with_goal(&scratch, command, goal).await;
    let (conn, mut inbox) = connected(&app).await;

    app.command(&conn, Command::PrepareSkills).await;

    let error = frame_matching(&mut inbox, |frame| frame["type"] == "error", 5_000).await;
    assert_eq!(
        error["message"],
        "The goal is not set. Save a non-empty goal before preparing skills."
    );
    assert!(log_lines(&scratch, "spawn ").is_empty(), "no peer started");
}

/// A non-default `GOAL_FILE` receives the created goal, and `GetGoal` reads it
/// back from that same document.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn creation_writes_and_reads_the_configured_goal_file() {
    let scratch = Scratch::new("creation-configured-goal");
    let goal = scratch.path().join("docs").join("GOAL.md");
    std::fs::create_dir_all(goal.parent().expect("the goal directory"))
        .expect("the goal directory exists");
    let command = stub_command(
        &scratch,
        &["--create-goal", &format!("--goal={}", goal.display())],
    );
    let app = app_with_goal(&scratch, command, goal.clone()).await;
    let (conn, mut inbox) = connected(&app).await;

    app.command(&conn, Command::CreateGoal).await;

    frame_matching(
        &mut inbox,
        |frame| frame["type"] == "goalCreationStarted",
        5_000,
    )
    .await;
    let question = frame_matching(&mut inbox, |frame| frame["type"] == "question", 5_000).await;
    app.command(
        &conn,
        Command::Answer {
            id: Some(question["id"].clone()),
            value: Some(json!("Alpha")),
            lane: None,
        },
    )
    .await;

    let stopped = frame_matching(
        &mut inbox,
        |frame| frame["type"] == "goalCreationStopped",
        10_000,
    )
    .await;
    assert_eq!(stopped["completed"], true);
    assert_eq!(
        std::fs::read_to_string(&goal).expect("the goal exists"),
        "# Created goal\n\nThe agent wrote this."
    );
    assert!(!scratch.path().join("GOAL.md").exists());

    app.command(&conn, Command::GetGoal).await;
    let state = frame_matching(&mut inbox, |frame| frame["type"] == "goal", 5_000).await;
    assert_eq!(state["text"], "# Created goal\n\nThe agent wrote this.");
}

/// Goal creation preempts runs, never the long-lived Issues worker.
#[tokio::test]
async fn preemption_keeps_the_issues_worker() {
    struct CountingGate(Arc<AtomicU64>);
    impl ModeGate for CountingGate {
        fn has_active_work(&self) -> bool {
            true
        }

        fn busy_reason(&self) -> Option<String> {
            None
        }

        fn abort_active_work(&self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    let scratch = Scratch::new("preemption");
    let app = App::new(
        config_at(&scratch, "omp acp".to_string()),
        Journal::open(&scratch.path().join("state"), scratch.path(), 0),
    );
    let issues = Arc::new(AtomicU64::new(0));
    let other = Arc::new(AtomicU64::new(0));
    app.shared
        .register_gate("issues", Arc::new(CountingGate(Arc::clone(&issues))));
    app.shared
        .register_gate("goal-authoring", Arc::new(CountingGate(Arc::clone(&other))));
    app.shared.abort_all_work();
    assert_eq!(
        issues.load(Ordering::SeqCst),
        0,
        "goal creation must not stop the Issues worker"
    );
    assert_eq!(
        other.load(Ordering::SeqCst),
        1,
        "goal creation still preempts the runs it replaces"
    );
}

/// An edited Discover document with a missing description belongs to the
/// Discover page: preparation completes, keeps the skills it wrote, and leaves
/// the Discover directory byte for byte.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_discover_metadata_fault_never_fails_preparation() {
    let scratch = Scratch::new("discover-fault");
    std::fs::write(scratch.path().join("GOAL.md"), "# Fixture goal\n").expect("the goal");
    let discover = scratch
        .path()
        .join(".omp")
        .join("skills")
        .join("discover-orders");
    std::fs::create_dir_all(&discover).expect("the discover skill directory");
    let discover_source = "---\nname: discover-orders\ndescription:\nmetadata:\n  \
        devboard-managed: \"true\"\n  devboard-family: \"discover\"\n---\n\n\
        - Keep the order aggregate authoritative.\n";
    std::fs::write(discover.join("SKILL.md"), discover_source).expect("the discover SKILL.md");

    let command = stub_command(&scratch, &["--prepare-skills"]);
    let app = app_with(&scratch, command).await;
    let (conn, mut inbox) = connected(&app).await;

    app.command(&conn, Command::PrepareSkills).await;

    let (stopped, frames) = collect_until(
        &mut inbox,
        |frame| frame["type"] == "skillsPreparationStopped",
        10_000,
    )
    .await;
    assert_eq!(stopped["completed"], true);
    let failures: Vec<&Value> = frames
        .iter()
        .filter(|frame| frame["type"] == "error")
        .collect();
    assert!(failures.is_empty(), "{failures:?}");
    let skills_dir = scratch.path().join(".omp").join("skills");
    assert!(skills_dir
        .join("dependency-direction")
        .join("SKILL.md")
        .is_file());
    assert_eq!(
        std::fs::read_to_string(discover.join("SKILL.md")).expect("the discover skill survives"),
        discover_source
    );
}

/// The `.omp/skills` tree as relative path to bytes, sorted, so a refused
/// preparation can be compared byte for byte with the tree it started from.
fn skill_tree(root: &Path) -> Vec<(String, Vec<u8>)> {
    fn walk(root: &Path, relative: &str, files: &mut Vec<(String, Vec<u8>)>) {
        let Ok(reader) = std::fs::read_dir(root.join(relative)) else {
            return;
        };
        for entry in reader.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let next = if relative.is_empty() {
                name
            } else {
                format!("{relative}/{name}")
            };
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                walk(root, &next, files);
            } else if file_type.is_file() {
                files.push((
                    next.clone(),
                    std::fs::read(root.join(&next)).unwrap_or_default(),
                ));
            }
        }
    }
    let mut files = Vec::new();
    walk(root, "", &mut files);
    files.sort();
    files
}

/// The same fault inside the `prepare` family stays fatal: the run stops with
/// the empty description named and restores the previous skills tree byte for
/// byte.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_prepare_metadata_fault_fails_preparation_and_rolls_back() {
    let scratch = Scratch::new("prepare-fault");
    std::fs::write(scratch.path().join("GOAL.md"), "# Fixture goal\n").expect("the goal");
    let skills_dir = scratch.path().join(".omp").join("skills");
    let legacy = skills_dir.join("legacy-style");
    std::fs::create_dir_all(&legacy).expect("the previous skill directory");
    std::fs::write(
        legacy.join("SKILL.md"),
        "---\nname: legacy-style\ndescription: A prepared skill from an earlier run.\n\
         metadata:\n  devboard-managed: \"true\"\n---\n\n- Keep one writer.\n",
    )
    .expect("the previous SKILL.md");
    let house = skills_dir.join("house-style");
    std::fs::create_dir_all(&house).expect("the hand-authored directory");
    std::fs::write(
        house.join("SKILL.md"),
        "---\nname: house-style\ndescription: The operator's own style.\n---\n\n\
         - Keep every rule.\n",
    )
    .expect("the hand-authored SKILL.md");
    let before = skill_tree(&skills_dir);

    let command = stub_command(&scratch, &["--prepare-skills", "--prepare-skills-invalid"]);
    let app = app_with(&scratch, command).await;
    let (conn, mut inbox) = connected(&app).await;

    app.command(&conn, Command::PrepareSkills).await;

    let failure = frame_matching(&mut inbox, |frame| frame["type"] == "error", 10_000).await;
    let message = failure["message"].as_str().unwrap_or_default();
    assert!(
        message.starts_with("Skills preparation failed: "),
        "{message}"
    );
    assert!(
        message.contains("skill \"invalid-skill\" has an empty description."),
        "{message}"
    );
    let (stopped, _frames) = collect_until(
        &mut inbox,
        |frame| frame["type"] == "skillsPreparationStopped",
        10_000,
    )
    .await;
    assert_eq!(stopped["completed"], false);
    assert_eq!(skill_tree(&skills_dir), before);
}
