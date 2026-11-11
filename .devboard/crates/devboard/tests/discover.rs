//! Discover Mode: the crawl, its published artifacts, and the remote target.

use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use devboard::app::{App, Conn};
use devboard::command::Command;
use devboard::config::Config;
use devboard::journal::Journal;
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

/// The checkout a clone runner produces: a committed repository whose one host
/// file can ground a glossary.
fn clone_checkout(checkout: &Path) {
    std::fs::create_dir_all(checkout).expect("the clone directory");
    write(
        &checkout.join("README.md"),
        "# Fresh\n\nA freshly cloned fixture host.\n",
    );
    git(checkout, &["init", "-q"]);
    git(checkout, &["add", "-A"]);
    git(
        checkout,
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
}

fn config(repo: &Path, state: &Path, command: String) -> Config {
    Config {
        hostname: "127.0.0.1".to_string(),
        port: 0,
        adrs_dir: repo.join("adrs"),
        repo_dir: repo.to_path_buf(),
        goal_file: repo.join("GOAL.md"),
        static_dir: None,
        agent_command: command,
        state_dir: state.to_path_buf(),
        allowed_hosts: Vec::new(),
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
    // The host's prompt is the readable fallback a retained target lacks.
    write(
        &repo.join(".devboard/prompts/discover-sheet.md"),
        "# The host's copy\n",
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
                clone_checkout(&cwd.join(name));
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
    // A retained project keeps only the published artifacts, so its card falls
    // back to the host's readable prompt instead of reporting a missing file.
    let sheet = payload["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|agent| agent["id"] == json!("sheet"))
        .expect("the sheet card");
    assert_eq!(sheet["prompt"]["error"], Value::Null);
    assert_eq!(
        sheet["prompt"]["text"],
        json!(
            std::fs::read_to_string(repo.join(".devboard/prompts/discover-sheet.md"))
                .expect("the host prompt")
        )
    );

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
    let command = format!(
        "{} --discover --discover-requires-wrappers --log={}",
        stub_agent(),
        log.display()
    );
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
                clone_checkout(&cwd.join(name));
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
    assert!(
        !retained.join(".omp/commands").exists(),
        "the retained project keeps no checkout scaffolding"
    );
    // The stub refuses a turn whose checkout holds no wrapper or prompt, and logs
    // the pair it found, so this proves both were in the clone when the first
    // prompt of each agent arrived.
    let agent_log = std::fs::read_to_string(&log).expect("the stub log");
    for command in [
        "discover-sheet",
        "discover-glossary",
        "discover-testing-strategy",
        "discover-naming-conventions",
        "discover-coding-conventions",
        "discover-architecture-boundaries",
        "discover-contribution",
    ] {
        assert!(
            agent_log.contains(&format!("harness {command} wrapper,prompt")),
            "the {command} turn found its wrapper and prompt in the checkout: {agent_log}"
        );
    }
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
    assert!(
        payload["manifest"].is_object(),
        "the published manifest reads back: {}",
        payload["error"]
    );
    assert!(payload["sheet"].is_object());
    assert_eq!(payload["retained"].as_array().unwrap().len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_remote_run_shows_the_prompt_its_live_checkout_holds() {
    let _clone_guard = CLONE_LOCK.lock().await;
    let scratch = Scratch::new("prompt-source");
    let repo = fixture_repo(&scratch, "repo", true);
    let state = repo.join("state");
    std::fs::create_dir_all(&state).expect("a state directory");
    provider(&state);
    // The host edit differs from the compiled copy the checkout receives.
    write(
        &repo.join(".devboard/prompts/discover-sheet.md"),
        "# The host's edit\n",
    );
    let log = scratch.path().join("agent.log");
    let command = format!(
        "{} --discover --discover-delay-ms=20000 --log={}",
        stub_agent(),
        log.display()
    );
    std::env::set_var("DEVBOARD_OPENCODE_GO_USAGE_BASE_URL", "http://127.0.0.1:1");
    let app = App::new(
        config(&repo, &state, command),
        Journal::open(&state, &repo, 0),
    );
    devboard::discover_mode::set_clone_runner(Some(Arc::new(
        |request| -> devboard::discover_mode::CloneFuture {
            let cwd = request.cwd.clone();
            let name = request.argv.last().cloned().unwrap_or_default();
            Box::pin(async move {
                clone_checkout(&cwd.join(name));
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
    // The clone becomes the live checkout before its first turn starts, and the
    // stub's delay holds that checkout while the page reads its prompts.
    frames_until(
        &mut inbox,
        |frame| {
            frame.get("type").and_then(Value::as_str) == Some("discoverState")
                && frame["state"]["target"]["checkout"] == json!(true)
        },
        Duration::from_secs(60),
    )
    .await;
    app.command(&conn, Command::GetDiscover).await;
    let states = frames_until(
        &mut inbox,
        |frame| frame.get("type").and_then(Value::as_str) == Some("discoverState"),
        Duration::from_secs(30),
    )
    .await;
    let payload = state_of(states.last().expect("a discover state"));
    let sheet = payload["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|agent| agent["id"] == json!("sheet"))
        .expect("the sheet card");
    let shipped = std::fs::read_to_string(devboard_root().join("prompts/discover-sheet.md"))
        .expect("the shipped prompt");
    assert_eq!(sheet["prompt"]["error"], Value::Null);
    assert_eq!(
        sheet["prompt"]["text"],
        json!(shipped),
        "the card shows the file the checkout's agent reads"
    );

    app.command(&conn, Command::StopDiscover).await;
    let stopped = frames_until(
        &mut inbox,
        |frame| frame.get("type").and_then(Value::as_str) == Some("discoverStopped"),
        Duration::from_secs(60),
    )
    .await;
    assert_eq!(
        by_type(&stopped, "discoverStopped")[0]["completed"],
        json!(false)
    );
}

fn write_state_file(state: &Path, repo: &Path, discover: Value) {
    let mut value = devboard::state::default_state();
    value["discover"] = discover.clone();
    value["discoverInterrupted"] = json!(true);
    let path = devboard::state::state_file(state, repo);
    devboard::state::write_state_file(&path, &devboard::state::state_envelope(&value))
        .expect("the restored state file");
}

fn failing_clone_runner() -> Arc<
    dyn Fn(devboard::discover_mode::CloneRequest) -> devboard::discover_mode::CloneFuture
        + Send
        + Sync,
> {
    Arc::new(|_request| -> devboard::discover_mode::CloneFuture {
        Box::pin(async move {
            devboard::discover_mode::CloneResult {
                code: 1,
                stderr: "fatal: repository not found".to_string(),
                timed_out: false,
            }
        })
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_resumed_clone_failure_reports_and_removes_the_interrupted_staging() {
    let _clone_guard = CLONE_LOCK.lock().await;
    let scratch = Scratch::new("resume-clone");
    let repo = fixture_repo(&scratch, "repo", true);
    let state = repo.join("state");
    std::fs::create_dir_all(&state).expect("a state directory");
    provider(&state);
    let interrupted = repo.join(".omp/discover/staging/run-interrupted");
    write(&interrupted.join("sheet.json"), "{\"values\":{}}\n");
    write_state_file(
        &state,
        &repo,
        json!({
            "runId": "run-interrupted",
            "stagingDir": interrupted.to_string_lossy(),
            "startedAt": "2026-01-01T00:00:00.000Z",
            "agent": "discover-testing-strategy",
            "activity": [],
            "question": null,
            "remote": {"url": "https://github.com/acme/fresh", "owner": "acme", "repo": "fresh"},
        }),
    );
    devboard::discover_mode::set_clone_runner(Some(failing_clone_runner()));

    let app = App::new(
        config(&repo, &state, format!("{} --discover", stub_agent())),
        Journal::open(&state, &repo, 0),
    );
    assert!(
        !interrupted.exists(),
        "restore removes the interrupted run's staging"
    );
    assert!(
        !repo.join(".omp/discover/staging").exists(),
        "an empty staging root goes too"
    );

    let (conn, mut inbox) = connect(&app);
    app.register(conn.clone()).await;
    app.open(&conn).await;
    let frames = frames_until(
        &mut inbox,
        |frame| frame.get("type").and_then(Value::as_str) == Some("discoverError"),
        Duration::from_secs(30),
    )
    .await;
    let error = by_type(&frames, "discoverError");
    assert_eq!(error.len(), 1, "one clone failure frame: {frames:?}");
    assert!(
        error[0]["message"]
            .as_str()
            .unwrap_or("")
            .contains("The repository clone failed"),
        "{error:?}"
    );
    devboard::discover_mode::set_clone_runner(None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_resumed_provider_failure_reaches_the_page() {
    let scratch = Scratch::new("resume-provider");
    let repo = fixture_repo(&scratch, "repo", false);
    let state = repo.join("state");
    std::fs::create_dir_all(&state).expect("a state directory");
    let interrupted = repo.join(".omp/discover/staging/run-interrupted");
    write(&interrupted.join("sheet.json"), "{\"values\":{}}\n");
    write_state_file(
        &state,
        &repo,
        json!({
            "runId": "run-interrupted",
            "stagingDir": interrupted.to_string_lossy(),
            "startedAt": "2026-01-01T00:00:00.000Z",
            "agent": "discover-testing-strategy",
            "activity": [],
            "question": null,
            "remote": null,
        }),
    );
    std::env::set_var("DEVBOARD_OPENCODE_GO_USAGE_BASE_URL", "http://127.0.0.1:1");
    let app = App::new(
        config(&repo, &state, format!("{} --discover", stub_agent())),
        Journal::open(&state, &repo, 0),
    );
    assert!(
        !interrupted.exists(),
        "restore removes the interrupted staging"
    );

    let (conn, mut inbox) = connect(&app);
    app.register(conn.clone()).await;
    app.open(&conn).await;
    let frames = frames_until(
        &mut inbox,
        |frame| frame.get("type").and_then(Value::as_str) == Some("discoverError"),
        Duration::from_secs(30),
    )
    .await;
    let error = by_type(&frames, "discoverError");
    assert_eq!(error.len(), 1, "one provider failure frame: {frames:?}");
    assert!(
        error[0]["message"]
            .as_str()
            .unwrap_or("")
            .contains("Could not start the Testing Strategy agent"),
        "{error:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_graceful_shutdown_removes_the_active_staging() {
    let scratch = Scratch::new("shutdown");
    let repo = fixture_repo(&scratch, "repo", false);
    let state = repo.join("state");
    std::fs::create_dir_all(&state).expect("a state directory");
    provider(&state);
    let command = format!("{} --discover --discover-delay-ms=30000", stub_agent());
    std::env::set_var("DEVBOARD_OPENCODE_GO_USAGE_BASE_URL", "http://127.0.0.1:1");
    let app = App::new(
        config(&repo, &state, command),
        Journal::open(&state, &repo, 0),
    );
    let (conn, mut inbox) = connect(&app);
    app.register(conn.clone()).await;
    app.open(&conn).await;
    let _ = drain(&mut inbox).await;

    app.command(
        &conn,
        Command::DiscoverAgent {
            agent: Some(json!("discover-testing-strategy")),
        },
    )
    .await;
    let started = next_frame(&mut inbox, Duration::from_secs(30)).await;
    assert_eq!(started["type"], json!("discoverStarted"));
    let run_id = started["runId"].as_str().expect("a run id").to_string();
    let staging = repo.join(".omp/discover/staging").join(&run_id);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while !staging.exists() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the run prepared its staging directory"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    app.shared.shutdown.notify_waiters();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while staging.exists() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "shutdown removed the staging directory"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn usage_glossary() -> devboard::discover_mode::Glossary {
    devboard::discover_mode::Glossary {
        bounded_context: "orders".to_string(),
        titles: Vec::new(),
        concepts: vec![devboard::discover_mode::Concept {
            id: "order-total".to_string(),
            pref_labels: vec![devboard::discover_mode::Label {
                language: "en".to_string(),
                text: "order total".to_string(),
            }],
            alt_labels: Vec::new(),
            hidden_labels: Vec::new(),
            definitions: Vec::new(),
            scope_note: None,
            example: None,
            history_note: None,
            status: "confirmed".to_string(),
            origin: "owner".to_string(),
            standard_ref: None,
            kind: "entity".to_string(),
            grounding: Vec::new(),
            broader: None,
            related: Vec::new(),
        }],
    }
}

#[test]
fn a_second_usage_analysis_reuses_the_cached_fingerprint() {
    let scratch = Scratch::new("usage-cache");
    let repo = scratch.path().join("repo");
    std::fs::create_dir_all(&repo).expect("a repository");
    git(&repo, &["init", "-q"]);
    write(&repo.join("src/order.ts"), "orderTotal\norderTotal\n");
    let glossaries = vec![usage_glossary()];
    let first = devboard::discover_mode::glossary_usage(&repo, &glossaries, "fingerprint-one");
    assert_eq!(first["orders"]["order-total"]["count"], json!(2));

    // The same fingerprint and glossary must not read the tree again.
    write(
        &repo.join("src/order.ts"),
        "orderTotal\norderTotal\norderTotal\norderTotal\norderTotal\n",
    );
    let cached = devboard::discover_mode::glossary_usage(&repo, &glossaries, "fingerprint-one");
    assert_eq!(cached, first, "the cached analysis is returned unchanged");

    let fresh = devboard::discover_mode::glossary_usage(&repo, &glossaries, "fingerprint-two");
    assert_eq!(fresh["orders"]["order-total"]["count"], json!(5));
}

#[test]
fn symlinked_usage_files_are_counted() {
    let scratch = Scratch::new("usage-symlink");
    let repo = scratch.path().join("repo");
    std::fs::create_dir_all(repo.join("src")).expect("a repository");
    git(&repo, &["init", "-q"]);
    let target = scratch.path().join("linked-source.ts");
    write(&target, "orderTotal\n");
    std::os::unix::fs::symlink("../../linked-source.ts", repo.join("src/order.ts"))
        .expect("a symlink");

    let usage =
        devboard::discover_mode::glossary_usage(&repo, &[usage_glossary()], "fingerprint-symlink");
    assert_eq!(usage["orders"]["order-total"]["files"], json!(1));
    assert_eq!(usage["orders"]["order-total"]["count"], json!(1));
    assert_eq!(
        usage["orders"]["order-total"]["examples"],
        json!(["orderTotal"])
    );
}

#[test]
fn overview_links_percent_encode_every_reserved_character() {
    let scratch = Scratch::new("overview-encode");
    let repo = scratch.path().join("repo");
    write(&repo.join("src/a b!'()~.ts"), "export {};\n");
    let sheet = json!({
        "architecture": {"sharedKernels": {"value": ["src/a b!'()~.ts"]}},
    });
    let links = devboard::discover_mode::overview_path_links(&repo, Some(&sheet), true);
    let href = links["src/a b!'()~.ts"]
        .as_str()
        .expect("the overview link");
    assert!(href.starts_with("vscode://file/"));
    for raw in [" ", "!", "'", "(", ")", "~"] {
        assert!(!href.contains(raw), "{raw:?} stays encoded in {href}");
    }
    for encoded in ["%20", "%21", "%27", "%28", "%29", "%7E"] {
        assert!(href.contains(encoded), "{encoded} in {href}");
    }
}

#[test]
fn an_unreadable_skill_fails_the_publishing_run() {
    let scratch = Scratch::new("unreadable-skill");
    let repo = fixture_repo(&scratch, "repo", false);
    let staging = scratch.path().join("staging");
    std::fs::create_dir_all(staging.join("skills/discover-testing-strategy"))
        .expect("a skill directory");
    std::os::unix::fs::symlink(
        staging.join("missing-skill-target.md"),
        staging.join("skills/discover-testing-strategy/SKILL.md"),
    )
    .expect("a dangling skill link");

    let facts = devboard::discover_mode::host_facts(&repo);
    let error = match devboard::discover_mode::publish_agent_staged(
        &repo,
        "run-unreadable",
        &facts,
        &staging,
        "fixture",
        "discover-testing-strategy",
    ) {
        Ok(_) => panic!("an unreadable skill stops publication"),
        Err(error) => error,
    };
    assert!(
        error.contains("could not read skills/discover-testing-strategy/SKILL.md"),
        "{error}"
    );
}

#[test]
fn a_staged_skill_description_is_published_by_character_count() {
    let scratch = Scratch::new("skill-description-chars");
    let repo = fixture_repo(&scratch, "repo", false);
    let staging = scratch.path().join("staging");
    let description = "技".repeat(1024);
    assert!(
        description.len() > 1024,
        "the description exceeds 1024 bytes"
    );
    write(
        &staging.join("skills/discover-testing-strategy/SKILL.md"),
        &format!(
            concat!(
                "---\n",
                "name: discover-testing-strategy\n",
                "description: \"{}\"\n",
                "metadata:\n",
                "  devboard-managed: \"true\"\n",
                "  devboard-family: \"discover\"\n",
                "  devboard-skill: testing-strategy\n",
                "---\n\n",
                "# Testing\n\n",
                "- Run the suite.\n",
            ),
            description
        ),
    );

    let facts = devboard::discover_mode::host_facts(&repo);
    devboard::discover_mode::publish_agent_staged(
        &repo,
        "run-description-chars",
        &facts,
        &staging,
        "fixture",
        "discover-testing-strategy",
    )
    .expect("a 1024-character description publishes");
    let published =
        std::fs::read_to_string(repo.join(".omp/skills/discover-testing-strategy/SKILL.md"))
            .expect("the published skill");
    assert!(published.contains(&description), "{published}");
}

#[test]
fn usage_examples_order_case_insensitively() {
    let scratch = Scratch::new("usage-order");
    let repo = scratch.path().join("repo");
    std::fs::create_dir_all(&repo).expect("a repository");
    git(&repo, &["init", "-q"]);
    write(&repo.join("a.ts"), "const Zebra = 1;\n");
    write(&repo.join("b.ts"), "const appleZebra = 2;\n");
    let mut glossary = usage_glossary();
    glossary.concepts[0].pref_labels[0].text = "zebra".to_string();
    let usage = devboard::discover_mode::glossary_usage(&repo, &[glossary], "fingerprint-examples");
    assert_eq!(
        usage["orders"]["order-total"]["examples"],
        json!(["appleZebra", "Zebra"])
    );
}

#[test]
fn dependency_repositories_resolve_a_workspace_install() {
    let scratch = Scratch::new("workspace-deps");
    let repo = scratch.path().join("repo");
    write(
        &repo.join("node_modules/root-pkg/package.json"),
        r#"{"name":"root-pkg","repository":"https://github.com/acme/root-pkg.git"}"#,
    );
    write(
        &repo.join("packages/app/package.json"),
        r#"{"name":"app","dependencies":{"left-pad":"1.3.0"}}"#,
    );
    write(
        &repo.join("packages/app/node_modules/left-pad/package.json"),
        r#"{"name":"left-pad","repository":{"type":"git","url":"git+https://github.com/stevemao/left-pad.git"}}"#,
    );
    let sheet = json!({
        "stack": {"dependencies": {"value": ["left-pad@1.3.0", "root-pkg@2.0.0"]}},
        "runtime": {"manifests": {"value": ["package.json", "packages/app/package.json"]}},
    });
    let links = devboard::discover_mode::dependency_repositories(&repo, Some(&sheet));
    assert_eq!(
        links["left-pad"],
        json!("https://github.com/stevemao/left-pad")
    );
    assert_eq!(links["root-pkg"], json!("https://github.com/acme/root-pkg"));
}

#[test]
fn an_escaping_manifest_contributes_no_install_root() {
    let scratch = Scratch::new("escaping-manifest");
    let repo = scratch.path().join("repo");
    std::fs::create_dir_all(&repo).expect("a repository");
    write(
        &scratch
            .path()
            .join("outside/node_modules/left-pad/package.json"),
        r#"{"name":"left-pad","repository":"https://github.com/stevemao/left-pad.git"}"#,
    );
    let stack = json!({"dependencies": {"value": ["left-pad@1.3.0"]}});
    for manifest in ["../outside/package.json", "/outside/package.json"] {
        let sheet = json!({
            "stack": stack,
            "runtime": {"manifests": {"value": [manifest]}},
        });
        let links = devboard::discover_mode::dependency_repositories(&repo, Some(&sheet));
        assert_eq!(links, json!({}), "{manifest} contributes no install root");
    }
}

fn glossary_document(context: &str, concepts: &[(&str, &str)]) -> String {
    let mut lines = vec![
        format!("boundedContext: {context}"),
        "titles:".to_string(),
        "  - language: en".to_string(),
        format!("    text: {}", json!(format!("{context} fixture terms"))),
        "concepts:".to_string(),
    ];
    for (id, label) in concepts {
        lines.push(format!("  - id: {id}"));
        lines.push("    prefLabels:".to_string());
        lines.push("      - language: en".to_string());
        lines.push(format!("        text: {}", json!(label)));
        lines.push("    altLabels: []".to_string());
        lines.push("    hiddenLabels: []".to_string());
        lines.push("    definitions:".to_string());
        lines.push("      - language: en".to_string());
        lines.push(format!(
            "        text: {}",
            json!(format!("{label} is a fixture term."))
        ));
        lines.push("    status: unconfirmed".to_string());
        lines.push("    origin: owner".to_string());
        lines.push("    kind: entity".to_string());
        lines.push("    grounding:".to_string());
        lines.push("      - \"code:src/order.ts\"".to_string());
        lines.push("    related: []".to_string());
    }
    format!("{}\n", lines.join("\n"))
}

fn glossary_skill_document(contexts: &[&str]) -> String {
    let mut lines = vec![
        "---".to_string(),
        "name: discover-glossary".to_string(),
        "description: Use the canonical glossary, honor human decisions, and propose new terms explicitly."
            .to_string(),
        "metadata:".to_string(),
        "  devboard-managed: \"true\"".to_string(),
        "  devboard-family: \"discover\"".to_string(),
        "  devboard-skill: glossary".to_string(),
        "---".to_string(),
        String::new(),
        "# Glossary".to_string(),
        String::new(),
    ];
    for context in contexts {
        lines.push(format!(
            "- Treat .omp/discover/glossary/{context}.glossary.yaml as canonical for {context}."
        ));
    }
    format!("{}\n", lines.join("\n"))
}

fn stage_glossary_run(
    staging: &Path,
    glossaries: &[(&str, &[(&str, &str)])],
    significance: &Value,
) {
    for (context, concepts) in glossaries {
        write(
            &staging.join(format!("glossary/{context}.glossary.yaml")),
            &glossary_document(context, concepts),
        );
    }
    write(
        &staging.join("glossary/significance.json"),
        &serde_json::to_string(significance).expect("a sidecar"),
    );
    let contexts: Vec<&str> = glossaries.iter().map(|(context, _)| *context).collect();
    write(
        &staging.join("skills/discover-glossary/SKILL.md"),
        &glossary_skill_document(&contexts),
    );
}

#[test]
fn a_second_publication_keeps_unstaged_context_scores() {
    let scratch = Scratch::new("second-publish");
    let repo = fixture_repo(&scratch, "repo", false);
    let facts = devboard::discover_mode::host_facts(&repo);
    let first = scratch.path().join("staging-one");
    stage_glossary_run(
        &first,
        &[
            (
                "orders",
                &[("order-line", "Order Line"), ("order-total", "Order Total")],
            ),
            ("billing", &[("invoice-total", "Invoice Total")]),
        ],
        &json!({
            "schemaVersion": 1,
            "contexts": {
                "orders": {
                    "order-line": {"score": 40, "reason": "One line of an order."},
                    "order-total": {"score": 90, "reason": "The domain's central summed value."},
                },
                "billing": {
                    "invoice-total": {"score": 70, "reason": "Billing's central summed value."},
                },
            },
        }),
    );
    devboard::discover_mode::publish_agent_staged(
        &repo,
        "run-one",
        &facts,
        &first,
        "fixture",
        "discover-glossary",
    )
    .expect("the first publication succeeds");

    // The second run re-crawls only the orders context.
    let second = scratch.path().join("staging-two");
    stage_glossary_run(
        &second,
        &[("orders", &[("order-total", "Order Total")])],
        &json!({
            "schemaVersion": 1,
            "contexts": {
                "orders": {
                    "order-total": {"score": 95, "reason": "Restaged at the current score."},
                },
            },
        }),
    );
    devboard::discover_mode::publish_agent_staged(
        &repo,
        "run-two",
        &facts,
        &second,
        "fixture",
        "discover-glossary",
    )
    .expect("the second publication succeeds");

    let sidecar_path = repo.join(".omp/discover/significance.json");
    let sidecar: Value = serde_json::from_str(
        &std::fs::read_to_string(&sidecar_path).expect("the published sidecar"),
    )
    .expect("a JSON sidecar");
    assert_eq!(
        sidecar["contexts"]["orders"]["order-total"]["score"],
        json!(95)
    );
    assert_eq!(
        sidecar["contexts"]["orders"]["order-line"],
        Value::Null,
        "a preserved concept absent from the staged sidecar stays unscored"
    );
    assert_eq!(
        sidecar["contexts"]["billing"]["invoice-total"]["score"],
        json!(70),
        "the unstaged context keeps every score it had"
    );

    let artifacts = devboard::discover_mode::read_artifacts(&repo);
    let artifacts = artifacts.artifacts.expect("the publication is readable");
    assert_eq!(
        artifacts.significance["billing"]["invoice-total"]["score"],
        json!(70)
    );
    assert_eq!(
        artifacts.significance["orders"]["order-total"]["score"],
        json!(95)
    );
    assert_eq!(artifacts.significance["orders"]["order-line"], Value::Null);

    // A context whose concepts are no longer confirmed drops out entirely.
    let billing_path = repo.join(".omp/discover/glossary/billing.glossary.yaml");
    let billing = std::fs::read_to_string(&billing_path).expect("the billing glossary");
    write(
        &billing_path,
        &billing.replace("status: 'confirmed'", "status: 'deprecated'"),
    );
    let third = scratch.path().join("staging-three");
    stage_glossary_run(
        &third,
        &[("orders", &[("order-total", "Order Total")])],
        &json!({
            "schemaVersion": 1,
            "contexts": {
                "orders": {
                    "order-total": {"score": 95, "reason": "Restaged at the current score."},
                },
            },
        }),
    );
    devboard::discover_mode::publish_agent_staged(
        &repo,
        "run-three",
        &facts,
        &third,
        "fixture",
        "discover-glossary",
    )
    .expect("the third publication succeeds");
    let sidecar: Value = serde_json::from_str(
        &std::fs::read_to_string(&sidecar_path).expect("the published sidecar"),
    )
    .expect("a JSON sidecar");
    assert_eq!(
        sidecar["contexts"]["billing"],
        Value::Null,
        "a dropped context leaves no sidecar entries"
    );
    assert_eq!(
        sidecar["contexts"]["orders"]["order-total"]["score"],
        json!(95)
    );
    assert!(!billing_path.exists(), "the dropped glossary is deleted");
}

/// One staged glossary whose single concept grounds on `grounding`.
fn grounded_glossary(grounding: &str) -> String {
    format!(
        "boundedContext: orders
titles:
  - language: en
    text: \"Orders\"
concepts:
  - id: order
    prefLabels:
      - language: en
        text: \"Order\"
    altLabels: []
    hiddenLabels: []
    definitions:
      - language: en
        text: \"One customer order request.\"
    status: unconfirmed
    origin: owner
    kind: entity
    grounding:
      - \"{grounding}\"
    related: []
"
    )
}

fn staged_grounding_error(repo: &Path, grounding: &str) -> String {
    let files = devboard::discover_mode::host_files(repo);
    devboard::discover_mode::parse_glossary(
        &grounded_glossary(grounding),
        "orders.glossary.yaml",
        repo,
        &files,
        false,
        true,
    )
    .expect_err("the staged glossary is refused")
}

#[test]
fn a_directory_grounding_is_refused() {
    let scratch = Scratch::new("grounding-directory");
    let repo = fixture_repo(&scratch, "repo", false);
    assert!(
        repo.join("src").is_dir(),
        "the fixture carries a src directory"
    );
    let files = devboard::discover_mode::host_files(&repo);
    assert!(
        !files.iter().any(|file| file == "src"),
        "the host list carries files only"
    );
    assert_eq!(
        staged_grounding_error(&repo, "code:src"),
        "orders.glossary.yaml:concepts[0].grounding[0]: names src, which the host does not carry"
    );
}

#[test]
fn an_excluded_tree_grounding_is_refused() {
    let scratch = Scratch::new("grounding-excluded");
    let repo = fixture_repo(&scratch, "repo", true);
    assert!(
        repo.join(".devboard/package.json").is_file(),
        "the excluded tree exists on disk"
    );
    assert_eq!(
        staged_grounding_error(&repo, "code:.devboard/package.json"),
        "orders.glossary.yaml:concepts[0].grounding[0]: names .devboard/package.json, \
         which the host does not carry"
    );
}

#[test]
fn a_tracked_host_file_grounds_a_concept() {
    let scratch = Scratch::new("grounding-tracked");
    let repo = fixture_repo(&scratch, "repo", false);
    let files = devboard::discover_mode::host_files(&repo);
    let glossary = devboard::discover_mode::parse_glossary(
        &grounded_glossary("code:src/order.ts"),
        "orders.glossary.yaml",
        &repo,
        &files,
        false,
        true,
    )
    .expect("a tracked host file grounds the concept");
    assert_eq!(
        glossary.concepts[0].grounding,
        vec!["code:src/order.ts".to_string()]
    );
}
