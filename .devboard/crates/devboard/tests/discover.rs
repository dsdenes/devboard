//! Discover Mode: the crawl, its published artifacts, and the remote target.

use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use devboard::app::{App, Conn};
use devboard::config::Config;
use devboard::journal::Journal;
use devboard::protocol::Command;
use devboard::providers::{save_subscriptions, ProviderId, StoredSubscription};
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedReceiver;

fn devboard_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the devboard harness directory exists")
}

static CLONE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn stub_agent() -> String {
    format!("{} acp-stub", env!("CARGO_BIN_EXE_devboard"))
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
            "discover-{label}-{}-{nanos}-{}",
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

fn write(path: &Path, text: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("a parent directory");
    }
    std::fs::write(path, text).expect("a fixture file");
}

fn git(repo: &Path, args: &[&str]) {
    let status = ProcessCommand::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .status()
        .expect("git runs");
    assert!(status.success(), "git {args:?} failed");
}

fn fixture_repo(scratch: &Scratch, label: &str, harness_source: bool) -> PathBuf {
    let repo = scratch.path().join(label);
    write(&repo.join("package.json"), "{\"name\":\"fixture-host\",\"version\":\"1.0.0\",\"scripts\":{\"test\":\"bun test\",\"build\":\"bun run build\"}}\n");
    write(
        &repo.join("README.md"),
        "# Fixture\n\nA fixture project for the discover crawl.\n",
    );
    write(
        &repo.join("src/order.ts"),
        "export function orderTotal(): number {\n  return 0;\n}\n",
    );
    write(&repo.join("test/order.test.ts"), "import { test, expect } from \"bun:test\";\n\ntest(\"order\", () => {\n  expect(1).toBe(1);\n});\n");
    write(
        &repo.join(".github/workflows/ci.yml"),
        "name: ci\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n",
    );
    write(&repo.join("GOAL.md"), "# Fixture goal\n");
    write(&repo.join(".gitignore"), "state/\n");
    // The page reads its cards' prompts from the host's `.devboard/prompts`.
    let prompts = devboard_root().join(".devboard").join("prompts");
    if let Ok(entries) = std::fs::read_dir(&prompts) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with("discover-") || !name.ends_with(".md") {
                continue;
            }
            if let Ok(text) = std::fs::read_to_string(entry.path()) {
                write(&repo.join(".devboard").join("prompts").join(&name), &text);
            }
        }
    }
    std::fs::create_dir_all(repo.join("adrs")).expect("an adr directory");
    if harness_source {
        write(
            &repo.join(".devboard/package.json"),
            "{\"name\":\"@dsdenes/devboard\",\"version\":\"0.1.0\"}\n",
        );
    }
    git(&repo, &["init", "-q"]);
    git(&repo, &["add", "-A"]);
    git(
        &repo,
        &[
            "-c",
            "user.name=Discover Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "-q",
            "-m",
            "fixture",
        ],
    );
    repo
}

fn config(repo: &Path, state: &Path, command: String) -> Config {
    Config {
        hostname: "127.0.0.1".to_string(),
        port: 0,
        addr_dir: repo.join("adrs"),
        repo_dir: repo.to_path_buf(),
        goal_file: repo.join("GOAL.md"),
        static_dir: None,
        agent_command: command,
        state_dir: state.to_path_buf(),
        allowed_hosts: Vec::new(),
        token: "discover-token".to_string(),
        bootstrap: "test-bootstrap".to_string(),
        feedback: None,
    }
}

fn provider(state: &Path) {
    save_subscriptions(
        state,
        &[StoredSubscription {
            id: "fixture-subscription".to_string(),
            provider: ProviderId::OpenCodeGo,
            label: "Fixture".to_string(),
            key: "sk-fixture-discover-key".to_string(),
            enabled: true,
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            updated_at: "2026-01-01T00:00:00.000Z".to_string(),
        }],
    )
    .expect("the fixture credentials are saved");
}

fn connect(_app: &Arc<App>) -> (Conn, UnboundedReceiver<String>) {
    let (outbox, inbox) = tokio::sync::mpsc::unbounded_channel();
    let conn = Conn::new(outbox);
    (conn, inbox)
}

async fn drain(inbox: &mut UnboundedReceiver<String>) -> Vec<Value> {
    let mut frames = Vec::new();
    while let Ok(text) = inbox.try_recv() {
        frames.push(serde_json::from_str(&text).expect("a JSON frame"));
    }
    frames
}

async fn next_frame(inbox: &mut UnboundedReceiver<String>, timeout: Duration) -> Value {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        assert!(!remaining.is_zero(), "a discover frame before the deadline");
        let text = tokio::time::timeout(remaining, inbox.recv())
            .await
            .expect("a frame before the deadline")
            .expect("an open outbox");
        let frame: Value = serde_json::from_str(&text).expect("a JSON frame");
        let kind = frame.get("type").and_then(Value::as_str).unwrap_or("");
        if kind.starts_with("discover") {
            return frame;
        }
    }
}

/// Collects frames until one satisfies `done`, keeping every frame seen.
async fn frames_until(
    inbox: &mut UnboundedReceiver<String>,
    done: impl Fn(&Value) -> bool,
    timeout: Duration,
) -> Vec<Value> {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut frames = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        assert!(!remaining.is_zero(), "timed out; frames: {frames:?}");
        let frame = next_frame(inbox, remaining).await;
        let finished = done(&frame);
        frames.push(frame);
        if finished {
            return frames;
        }
    }
}

fn by_type<'a>(frames: &'a [Value], kind: &str) -> Vec<&'a Value> {
    frames
        .iter()
        .filter(|frame| frame.get("type").and_then(Value::as_str) == Some(kind))
        .collect()
}

fn state_of(frame: &Value) -> &Value {
    frame.get("state").expect("a discover state")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discover_project_publishes_every_slice_and_replays() {
    let scratch = Scratch::new("publish");
    let repo = fixture_repo(&scratch, "repo", false);
    let state = scratch.path().join("state");
    std::fs::create_dir_all(&state).expect("a state directory");
    provider(&state);
    let log = scratch.path().join("agent.log");
    let command = format!("{} --discover --log={}", stub_agent(), log.display());
    // An unusable usage endpoint answers at once instead of reaching a network.
    std::env::set_var("DEVBOARD_OPENCODE_GO_USAGE_BASE_URL", "http://127.0.0.1:1");
    let app = App::new(
        config(&repo, &state, command),
        Journal::open(&state, &repo, 0),
    );

    let (conn, mut inbox) = connect(&app);
    app.register(conn.clone()).await;
    app.open(&conn).await;
    let _ = drain(&mut inbox).await;

    app.command(&conn, Command::DiscoverProject).await;
    let frames = frames_until(
        &mut inbox,
        |frame| frame.get("type").and_then(Value::as_str) == Some("discoverStopped"),
        Duration::from_secs(180),
    )
    .await;

    assert!(
        by_type(&frames, "discoverError").is_empty(),
        "no agent may fail: {frames:?}"
    );
    let started = by_type(&frames, "discoverStarted");
    let agents: Vec<&str> = started
        .iter()
        .map(|frame| frame.get("agent").and_then(Value::as_str).unwrap_or(""))
        .collect();
    assert_eq!(
        agents,
        vec![
            "sheet",
            "discover-glossary",
            "discover-testing-strategy",
            "discover-naming-conventions",
            "discover-coding-conventions",
            "discover-architecture-boundaries",
            "discover-contribution",
        ]
    );
    let stopped = by_type(&frames, "discoverStopped");
    assert_eq!(stopped.len(), 1);
    assert_eq!(stopped[0]["completed"], json!(true));
    assert_eq!(stopped[0]["agent"], json!("discover-contribution"));
    assert_eq!(stopped[0]["mode"], json!("all"));

    let root = repo.join(".omp");
    for relative in [
        "discover/manifest.json",
        "discover/sheet.json",
        "discover/decisions.json",
        "discover/significance.json",
        "discover/glossary/orders.glossary.yaml",
        "discover/skills/discover-testing-strategy/SKILL.md",
        "discover/skills/discover-naming-conventions/SKILL.md",
        "discover/skills/discover-coding-conventions/SKILL.md",
        "discover/skills/discover-architecture-boundaries/SKILL.md",
        "discover/skills/discover-glossary/SKILL.md",
        "discover/skills/discover-contribution/SKILL.md",
        "skills/discover-testing-strategy/SKILL.md",
        "skills/discover-naming-conventions/SKILL.md",
        "skills/discover-coding-conventions/SKILL.md",
        "skills/discover-architecture-boundaries/SKILL.md",
        "skills/discover-glossary/SKILL.md",
        "skills/discover-contribution/SKILL.md",
    ] {
        assert!(root.join(relative).is_file(), "{relative} is published");
    }
    assert!(
        !root.join("discover/staging").exists(),
        "staging is removed"
    );
    let manifest: Value = serde_json::from_str(
        &std::fs::read_to_string(root.join("discover/manifest.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(manifest["schemaVersion"], json!(1));
    assert_eq!(
        manifest["paths"]["significance"],
        json!(".omp/discover/significance.json")
    );
    assert_eq!(
        manifest["skills"].as_array().unwrap().len(),
        6,
        "six baselines"
    );

    // The state the page reads names the published artifacts.
    app.command(&conn, Command::GetDiscover).await;
    let state_frame = next_frame(&mut inbox, Duration::from_secs(10)).await;
    assert_eq!(state_frame["type"], json!("discoverState"));
    let payload = state_of(&state_frame);
    assert_eq!(payload["runningAll"], json!(false));
    assert_eq!(payload["allFailed"], Value::Null);
    assert!(payload["sheet"].is_object(), "the sheet is published");
    assert_eq!(payload["glossaries"].as_array().unwrap().len(), 1);
    assert_eq!(payload["glossaries"][0]["boundedContext"], json!("orders"));
    assert_eq!(payload["skills"].as_array().unwrap().len(), 6);
    assert_eq!(
        payload["glossarySignificance"]["orders"]["order-total"]["score"],
        json!(90)
    );

    // A reconnect replays the published state without starting a run.
    let (second, mut replay) = connect(&app);
    app.register(second.clone()).await;
    app.open(&second).await;
    let replayed = frames_until(
        &mut replay,
        |frame| frame.get("type").and_then(Value::as_str) == Some("discoverState"),
        Duration::from_secs(10),
    )
    .await;
    let replay_state = state_of(replayed.last().expect("a discover state"));
    assert!(replay_state["sheet"].is_object());
    assert_eq!(replay_state["skills"].as_array().unwrap().len(), 6);
    let tail = drain(&mut replay).await;
    assert!(
        by_type(&tail, "discoverStarted").is_empty(),
        "a replay never starts a run"
    );
    assert_eq!(
        by_type(&tail, "discoverPromptState").len(),
        7,
        "every card's prompt follows"
    );
}

fn retained_project(scratch_root: &Path, owner: &str, repo: &str, url: &str) {
    let directory = scratch_root.join(format!("{owner}~{repo}").to_lowercase());
    write(
        &directory.join("project.json"),
        &format!(
            "{{\n  \"url\": \"{url}\",\n  \"owner\": \"{owner}\",\n  \"repo\": \"{repo}\",\n  \"completedAt\": \"2026-05-01T00:00:00.000Z\"\n}}\n"
        ),
    );
    std::fs::create_dir_all(directory.join(".omp/discover")).expect("a retained tree");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn remote_targets_clone_switch_and_refuse() {
    let _clone_guard = CLONE_LOCK.lock().await;
    let scratch = Scratch::new("remote");
    let repo = fixture_repo(&scratch, "repo", true);
    let state = repo.join("state");
    std::fs::create_dir_all(&state).expect("a state directory");
    let scratch_root = state.join("discover-remote");
    std::fs::create_dir_all(&scratch_root).expect("a scratch root");
    retained_project(
        &scratch_root,
        "acme",
        "retained",
        "https://github.com/acme/retained",
    );
    let log = scratch.path().join("agent.log");
    let command = format!("{} --discover --log={}", stub_agent(), log.display());
    let app = App::new(
        config(&repo, &state, command),
        Journal::open(&state, &repo, 0),
    );

    let clones: Arc<Mutex<Vec<devboard::discover_mode::CloneRequest>>> =
        Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&clones);
    devboard::discover_mode::set_clone_runner(Some(Arc::new(
        move |request| -> devboard::discover_mode::CloneFuture {
            recorded.lock().unwrap().push(request.clone());
            let cwd = request.cwd.clone();
            let name = request.argv.last().cloned().unwrap_or_default();
            Box::pin(async move {
                std::fs::create_dir_all(cwd.join(name)).expect("the clone directory");
                devboard::discover_mode::CloneResult {
                    code: 0,
                    stderr: String::new(),
                    timed_out: false,
                }
            })
        },
    )));

    let (conn, mut inbox) = connect(&app);
    app.register(conn.clone()).await;
    app.open(&conn).await;
    let _ = drain(&mut inbox).await;

    app.command(
        &conn,
        Command::SwitchDiscoverRemote {
            url: "https://github.com/acme/retained".to_string(),
        },
    )
    .await;
    let switched = next_frame(&mut inbox, Duration::from_secs(10)).await;
    assert_eq!(switched["type"], json!("discoverState"));
    let payload = state_of(&switched);
    assert_eq!(payload["target"]["kind"], json!("remote"));
    assert_eq!(
        payload["target"]["url"],
        json!("https://github.com/acme/retained")
    );
    assert_eq!(payload["target"]["owner"], json!("acme"));
    assert_eq!(payload["repository"], json!("acme/retained"));
    assert_eq!(payload["retained"].as_array().unwrap().len(), 1);

    // A repository URL clones once, then the first agent fails without a
    // provider. The clone never becomes the active target on its own.
    app.command(
        &conn,
        Command::DiscoverRemote {
            url: "https://github.com/acme/fresh".to_string(),
        },
    )
    .await;
    let failed = frames_until(
        &mut inbox,
        |frame| frame.get("type").and_then(Value::as_str) == Some("discoverError"),
        Duration::from_secs(120),
    )
    .await;
    let error = failed
        .iter()
        .find(|frame| frame.get("type").and_then(Value::as_str) == Some("discoverError"))
        .expect("a failure frame");
    assert!(
        error["message"]
            .as_str()
            .unwrap_or("")
            .starts_with("Could not start the Data Sheet agent:"),
        "{error:?}"
    );
    let _ = frames_until(
        &mut inbox,
        |frame| frame.get("type").and_then(Value::as_str) == Some("discoverStopped"),
        Duration::from_secs(30),
    )
    .await;
    let requests = clones.lock().unwrap().clone();
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    let expected: Vec<String> = [
        "git",
        "clone",
        "--depth",
        "1",
        "--single-branch",
        "--no-tags",
        "--",
        "https://github.com/acme/fresh",
    ]
    .iter()
    .map(|part| part.to_string())
    .collect();
    assert_eq!(&request.argv[..expected.len()], expected.as_slice());
    assert_eq!(request.argv.len(), expected.len() + 1);
    assert!(request.argv[expected.len()].starts_with(".staging-run-"));
    assert_eq!(request.cwd, scratch_root);
    assert_eq!(
        request.env.get("GIT_TERMINAL_PROMPT").map(String::as_str),
        Some("0")
    );
    assert_eq!(request.timeout_ms, 300_000);

    app.command(&conn, Command::GetDiscover).await;
    let after = next_frame(&mut inbox, Duration::from_secs(10)).await;
    let payload = state_of(&after);
    assert_eq!(payload["cloning"], Value::Null);
    assert_eq!(payload["active"], json!(false));
    assert_eq!(
        payload["target"]["url"],
        json!("https://github.com/acme/retained")
    );
    assert!(!scratch_root.join("acme~fresh").exists());

    app.command(&conn, Command::ClearDiscoverRemote).await;
    let cleared = next_frame(&mut inbox, Duration::from_secs(10)).await;
    assert_eq!(cleared["type"], json!("discoverState"));
    assert_eq!(state_of(&cleared)["target"]["kind"], json!("host"));

    app.command(&conn, Command::ClearDiscoverRemote).await;
    let refusal = next_frame(&mut inbox, Duration::from_secs(10)).await;
    assert_eq!(refusal["type"], json!("discoverError"));
    assert_eq!(
        refusal["message"],
        json!("No remote Discover target is active.")
    );

    app.command(
        &conn,
        Command::SwitchDiscoverRemote {
            url: "https://github.com/acme/unknown".to_string(),
        },
    )
    .await;
    let refusal = next_frame(&mut inbox, Duration::from_secs(10)).await;
    assert_eq!(
        refusal["message"],
        json!("No retained Discover project matches https://github.com/acme/unknown.")
    );

    app.command(
        &conn,
        Command::RemoveDiscoverRemote {
            url: "https://github.com/acme/retained".to_string(),
        },
    )
    .await;
    let removed = next_frame(&mut inbox, Duration::from_secs(10)).await;
    assert_eq!(removed["type"], json!("discoverState"));
    assert_eq!(state_of(&removed)["retained"].as_array().unwrap().len(), 0);
    assert!(!scratch_root.join("acme~retained").exists());

    app.command(
        &conn,
        Command::RemoveDiscoverRemote {
            url: "https://github.com/acme/retained".to_string(),
        },
    )
    .await;
    let refusal = next_frame(&mut inbox, Duration::from_secs(10)).await;
    assert_eq!(
        refusal["message"],
        json!("No retained Discover project matches https://github.com/acme/retained.")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn discover_refusals_report_the_exact_messages() {
    let scratch = Scratch::new("refusals");
    let repo = fixture_repo(&scratch, "repo", false);
    let state = scratch.path().join("state");
    std::fs::create_dir_all(&state).expect("a state directory");
    let app = App::new(
        config(&repo, &state, "bun stub.ts".to_string()),
        Journal::open(&state, &repo, 0),
    );
    let (conn, mut inbox) = connect(&app);
    app.register(conn.clone()).await;
    app.open(&conn).await;
    let _ = drain(&mut inbox).await;

    app.command(&conn, Command::StopDiscover).await;
    assert_eq!(
        next_frame(&mut inbox, Duration::from_secs(10)).await,
        json!({"type": "discoverError", "message": "No Discover run is active."})
    );

    app.command(
        &conn,
        Command::AnswerDiscover {
            id: Some(json!(1)),
            value: Some(json!("yes")),
        },
    )
    .await;
    assert_eq!(
        next_frame(&mut inbox, Duration::from_secs(10)).await,
        json!({"type": "discoverError", "message": "No Discover run is active."})
    );

    app.command(
        &conn,
        Command::DiscoverAgent {
            agent: Some(json!("scout")),
        },
    )
    .await;
    assert_eq!(
        next_frame(&mut inbox, Duration::from_secs(10)).await,
        json!({"type": "discoverError", "message": "Unknown Discover agent: scout."})
    );

    app.command(&conn, Command::DiscoverAgent { agent: None })
        .await;
    assert_eq!(
        next_frame(&mut inbox, Duration::from_secs(10)).await,
        json!({"type": "discoverError", "message": "A Discover start needs an agent id."})
    );

    app.command(
        &conn,
        Command::ConfirmGlossaryTerm {
            context: None,
            id: Some(json!("order")),
        },
    )
    .await;
    assert_eq!(
        next_frame(&mut inbox, Duration::from_secs(10)).await,
        json!({
            "type": "discoverError",
            "message": "Confirming a term needs its bounded context and id."
        })
    );

    app.command(
        &conn,
        Command::ConfirmGlossaryTerm {
            context: Some(json!("orders")),
            id: Some(json!("order")),
        },
    )
    .await;
    assert_eq!(
        next_frame(&mut inbox, Duration::from_secs(10)).await,
        json!({"type": "discoverError", "message": "no Discover artifacts are published"})
    );

    app.command(
        &conn,
        Command::RejectGlossaryTerm {
            context: Some(json!("orders")),
            id: Some(json!("order")),
            reason: None,
        },
    )
    .await;
    assert_eq!(
        next_frame(&mut inbox, Duration::from_secs(10)).await,
        json!({
            "type": "discoverError",
            "message": "Rejecting a term needs its bounded context, id, and reason."
        })
    );

    app.command(
        &conn,
        Command::SwitchDiscoverRemote {
            url: "https://github.com/acme/retained".to_string(),
        },
    )
    .await;
    assert_eq!(
        next_frame(&mut inbox, Duration::from_secs(10)).await,
        json!({
            "type": "discoverError",
            "message": "Discover from a repository URL is available only when the dashboard serves a harness source checkout."
        })
    );

    app.command(&conn, Command::GetDiscover).await;
    let state_frame = next_frame(&mut inbox, Duration::from_secs(10)).await;
    let payload = state_of(&state_frame);
    assert_eq!(payload["active"], json!(false));
    assert_eq!(payload["interrupted"], json!(false));
    assert_eq!(payload["remoteAvailable"], json!(false));
    assert_eq!(payload["target"]["kind"], json!("host"));
    assert_eq!(payload["sheet"], Value::Null);
    assert_eq!(payload["manifest"], Value::Null);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_state_section_round_trips_a_target() {
    let scratch = Scratch::new("section");
    let repo = fixture_repo(&scratch, "repo", false);
    let state = scratch.path().join("state");
    std::fs::create_dir_all(&state).expect("a state directory");
    let app = App::new(
        config(&repo, &state, "bun stub.ts".to_string()),
        Journal::open(&state, &repo, 0),
    );
    let value = app.shared.state_value();
    assert_eq!(value["discover"], Value::Null);
    assert_eq!(value["discoverInterrupted"], json!(false));
    assert_eq!(value["discoverTarget"], Value::Null);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_remote_run_retains_its_published_snapshot() {
    let _clone_guard = CLONE_LOCK.lock().await;
    let scratch = Scratch::new("retain");
    let repo = fixture_repo(&scratch, "repo", true);
    let state = repo.join("state");
    std::fs::create_dir_all(&state).expect("a state directory");
    provider(&state);
    let log = scratch.path().join("agent.log");
    let command = format!("{} --discover --log={}", stub_agent(), log.display());
    std::env::set_var("DEVBOARD_OPENCODE_GO_USAGE_BASE_URL", "http://127.0.0.1:1");
    let app = App::new(
        config(&repo, &state, command),
        Journal::open(&state, &repo, 0),
    );

    let clones: Arc<Mutex<Vec<devboard::discover_mode::CloneRequest>>> =
        Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&clones);
    devboard::discover_mode::set_clone_runner(Some(Arc::new(
        move |request| -> devboard::discover_mode::CloneFuture {
            recorded.lock().unwrap().push(request.clone());
            let cwd = request.cwd.clone();
            let name = request.argv.last().cloned().unwrap_or_default();
            Box::pin(async move {
                std::fs::create_dir_all(cwd.join(name)).expect("the clone directory");
                devboard::discover_mode::CloneResult {
                    code: 0,
                    stderr: String::new(),
                    timed_out: false,
                }
            })
        },
    )));

    let (conn, mut inbox) = connect(&app);
    app.register(conn.clone()).await;
    app.open(&conn).await;
    let _ = drain(&mut inbox).await;

    app.command(
        &conn,
        Command::DiscoverRemote {
            url: "https://github.com/acme/fresh".to_string(),
        },
    )
    .await;
    let frames = frames_until(
        &mut inbox,
        |frame| frame.get("type").and_then(Value::as_str) == Some("discoverStopped"),
        Duration::from_secs(240),
    )
    .await;
    assert!(
        by_type(&frames, "discoverError").is_empty(),
        "the remote crawl publishes every slice: {frames:?}"
    );
    let stopped = by_type(&frames, "discoverStopped");
    assert_eq!(stopped.len(), 1);
    assert_eq!(stopped[0]["completed"], json!(true));
    assert_eq!(clones.lock().unwrap().len(), 1);

    let remote_root = state.join("discover-remote");
    let retained = remote_root.join("acme~fresh");
    assert!(retained.join("project.json").is_file());
    assert!(retained.join(".omp/discover/manifest.json").is_file());
    assert!(retained.join(".omp/discover/sheet.json").is_file());
    assert!(retained
        .join(".omp/skills/discover-glossary/SKILL.md")
        .is_file());
    let record: Value =
        serde_json::from_str(&std::fs::read_to_string(retained.join("project.json")).unwrap())
            .unwrap();
    assert_eq!(record["url"], json!("https://github.com/acme/fresh"));
    assert_eq!(record["owner"], json!("acme"));
    assert_eq!(record["repo"], json!("fresh"));
    let transient: Vec<String> = std::fs::read_dir(&remote_root)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with('.'))
        .collect();
    assert!(
        transient.is_empty(),
        "no checkout staging survives: {transient:?}"
    );

    app.command(&conn, Command::GetDiscover).await;
    let state_frame = next_frame(&mut inbox, Duration::from_secs(10)).await;
    let payload = state_of(&state_frame);
    assert_eq!(payload["target"]["kind"], json!("remote"));
    assert_eq!(
        payload["target"]["url"],
        json!("https://github.com/acme/fresh")
    );
    assert_eq!(payload["target"]["checkout"], json!(false));
    assert_eq!(payload["repository"], json!("acme/fresh"));
    assert!(payload["manifest"].is_object());
    assert!(payload["sheet"].is_object());
    assert_eq!(payload["retained"].as_array().unwrap().len(), 1);
}
