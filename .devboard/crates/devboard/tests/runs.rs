//! Discover and Ask runs survive a dashboard replacement: one detached owner,
//! replayed activity, an answer routed to the same run, Stop, and no orphaned
//! ACP child.

use std::path::{Path, PathBuf};
use std::process::{Child, Command as ProcessCommand, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use devboard::providers::{save_subscriptions, ProviderId, StoredSubscription};
use futures_util::StreamExt;
use serde_json::{json, Value};
use sha2::Digest;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

#[cfg(target_os = "linux")]
mod common;

#[cfg(target_os = "linux")]
use common::AccessCounter;

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
            "runs-{label}-{}-{nanos}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(path.join("state")).expect("a state directory");
        std::fs::create_dir_all(path.join("repo/adrs")).expect("a repository");
        Self { path }
    }

    fn state(&self) -> PathBuf {
        self.path.join("state")
    }

    fn repo(&self) -> PathBuf {
        self.path.join("repo")
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

fn provider(state: &Path) {
    save_subscriptions(
        state,
        &[StoredSubscription {
            id: "fixture-subscription".to_string(),
            provider: ProviderId::OpenCodeGo,
            label: "Fixture".to_string(),
            key: "sk-fixture-runs-key".to_string(),
            enabled: true,
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            updated_at: "2026-01-01T00:00:00.000Z".to_string(),
        }],
    )
    .expect("the fixture credentials are saved");
}

fn fixture_repo(scratch: &Scratch) -> PathBuf {
    let repo = scratch.repo();
    write(&repo.join("README.md"), "# Runs fixture\n\nOne host.\n");
    write(
        &repo.join("src/order.ts"),
        "export function orderTotal(): number {\n  return 0;\n}\n",
    );
    write(&repo.join("GOAL.md"), "# Runs goal\n");
    for name in [
        "discover-sheet.md",
        "discover-contribution.md",
        "discover-testing-strategy.md",
        "discover-naming-conventions.md",
        "discover-coding-conventions.md",
        "discover-architecture-boundaries.md",
        "discover-glossary.md",
    ] {
        write(
            &repo.join(".devboard/prompts").join(name),
            "Fixture prompt.\n",
        );
    }
    repo
}

struct ServerProcess {
    child: Child,
    log: PathBuf,
    port: u16,
}

impl ServerProcess {
    fn base(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// Waits for the dashboard's own listening line, so two tests can never
    /// drive the same port.
    async fn listening_port(&mut self) -> u16 {
        if self.port != 0 {
            return self.port;
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            if let Ok(text) = std::fs::read_to_string(&self.log) {
                if let Some(index) = text.rfind("127.0.0.1:") {
                    let rest = &text[index + "127.0.0.1:".len()..];
                    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
                    if let Ok(port) = digits.parse::<u16>() {
                        self.port = port;
                        return port;
                    }
                }
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the dashboard reported its port"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
}

impl Drop for ServerProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn spawn_server(scratch: &Scratch, command: &str) -> ServerProcess {
    let repo = scratch.repo();
    let state = scratch.state();
    let binary = env!("CARGO_BIN_EXE_devboard");
    let log = scratch.path.join("dashboard.log");
    let output = std::fs::File::create(&log).expect("a dashboard log");
    let child = ProcessCommand::new(binary)
        .arg("serve")
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", std::env::var("HOME").unwrap_or_default())
        .env("HOST", "127.0.0.1")
        .env("PORT", "0")
        .env("ADRS_DIR", repo.join("adrs"))
        .env("REPO_DIR", &repo)
        .env("GOAL_FILE", repo.join("GOAL.md"))
        .env("STATE_DIR", &state)
        .env("AGENT_COMMAND", command)
        .env("DEVBOARD_OWNER_EXECUTABLE", binary)
        .env("DEVBOARD_UPDATE_INTERVAL_MS", "3600000")
        .env("DEVBOARD_OPENCODE_GO_USAGE_BASE_URL", "http://127.0.0.1:1")
        .stdin(Stdio::null())
        .stdout(Stdio::from(output.try_clone().expect("a log handle")))
        .stderr(Stdio::from(output))
        .spawn()
        .expect("the dashboard starts");
    ServerProcess {
        child,
        log,
        port: 0,
    }
}

async fn ready(base: &str) -> bool {
    reqwest::Client::new()
        .get(format!("{base}/ready"))
        .send()
        .await
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

async fn wait_ready(base: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        if ready(base).await {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the replacement dashboard became ready"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn run_socket(port: u16, id: &str, after: Option<u64>) -> Socket {
    let query = after
        .map(|cursor| format!("?after={cursor}"))
        .unwrap_or_default();
    let request = format!("ws://127.0.0.1:{port}/agent-runs/{id}/output{query}")
        .into_client_request()
        .expect("a socket URL");
    let (socket, _) = connect_async(request).await.expect("a run socket");
    socket
}

/// One action over REST, returning the frames the operation produced.
async fn rest(base: &str, frame: Value) -> Vec<Value> {
    let (method, path, body) =
        devboard::rest::request_for_command(&frame).expect("a REST operation");
    let client = reqwest::Client::new();
    let request = client
        .request(method, format!("{base}{path}"))
        .header("accept", "application/json");
    let request = if body.as_object().map(|object| object.is_empty()) == Some(true) {
        request
    } else {
        request.json(&body)
    };
    let response = request.send().await.expect("a response");
    let body: Value = response.json().await.expect("JSON");
    body["frames"].as_array().cloned().unwrap_or_default()
}

/// Asks for a replacement; the old process may stop before the answer ends.
async fn restart(base: &str) {
    let (method, path, _body) = devboard::rest::request_for_command(&json!({
        "type": "restartServer"
    }))
    .expect("a REST operation");
    let _ = reqwest::Client::new()
        .request(method, format!("{base}{path}"))
        .header("accept", "application/json")
        .send()
        .await;
}

/// Polls one GET resource until `done` accepts a frame.
async fn poll_frames(
    base: &str,
    frame: Value,
    done: impl Fn(&Value) -> bool,
    timeout: Duration,
    what: &str,
) -> Vec<Value> {
    let (method, path, body) =
        devboard::rest::request_for_command(&frame).expect("a REST operation");
    let deadline = tokio::time::Instant::now() + timeout;
    let client = reqwest::Client::new();
    loop {
        let request = client
            .request(method.clone(), format!("{base}{path}"))
            .header("accept", "application/json");
        let request = if body.as_object().map(|object| object.is_empty()) == Some(true) {
            request
        } else {
            request.json(&body)
        };
        if let Ok(response) = request.send().await {
            if let Ok(value) = response.json::<Value>().await {
                let frames = value["frames"].as_array().cloned().unwrap_or_default();
                if frames.iter().any(&done) {
                    return frames;
                }
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the resource answered before the deadline: {what}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// The id of the one run whose representation carries `needle`.
async fn run_id(base: &str, needle: &str) -> String {
    let client = reqwest::Client::new();
    let response = client
        .get(format!("{base}/agent-runs"))
        .header("accept", "application/json")
        .send()
        .await
        .expect("a run list");
    let body: Value = response.json().await.expect("JSON");
    body["runs"]
        .as_array()
        .and_then(|runs| {
            runs.iter().find_map(|run| {
                let label = run["label"].as_str().unwrap_or("");
                if label.contains(needle) {
                    run["id"].as_str().map(str::to_string)
                } else {
                    None
                }
            })
        })
        .unwrap_or_else(|| panic!("a run whose label contains {needle}: {body}"))
}

async fn frames_until(
    socket: &mut Socket,
    done: impl Fn(&Value) -> bool,
    timeout: Duration,
) -> Vec<Value> {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut frames = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        assert!(
            !remaining.is_zero(),
            "a frame arrived before the deadline; frames: {frames:?}"
        );
        match tokio::time::timeout(remaining, socket.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                if let Ok(frame) = serde_json::from_str::<Value>(&text) {
                    let finished = done(&frame);
                    frames.push(frame);
                    if finished {
                        return frames;
                    }
                }
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(error))) => panic!("the socket failed: {error}; frames: {frames:?}"),
            Ok(None) => panic!("the socket closed; frames: {frames:?}"),
            Err(_) => panic!("a frame arrived before the deadline; frames: {frames:?}"),
        }
    }
}

fn by_type<'a>(frames: &'a [Value], kind: &str) -> Vec<&'a Value> {
    frames
        .iter()
        .filter(|frame| frame.get("type").and_then(Value::as_str) == Some(kind))
        .collect()
}

fn runs_root(scratch: &Scratch) -> PathBuf {
    scratch
        .state()
        .join("runs")
        .join(devboard::journal::journal_key(&scratch.repo()))
}

fn run_directory(scratch: &Scratch) -> PathBuf {
    let root = runs_root(scratch);
    let mut found = Vec::new();
    for entry in std::fs::read_dir(&root).expect("the runs root").flatten() {
        if entry.path().join("state.json").is_file() {
            found.push(entry.path());
        }
    }
    assert_eq!(found.len(), 1, "exactly one run directory: {found:?}");
    found.pop().expect("a run directory")
}

fn run_state(scratch: &Scratch) -> Value {
    current_run_state(scratch).expect("a run state")
}

fn current_run_state(scratch: &Scratch) -> Option<Value> {
    let root = runs_root(scratch);
    let entries = std::fs::read_dir(&root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path().join("state.json");
        if let Ok(text) = std::fs::read_to_string(&path) {
            return serde_json::from_str(&text).ok();
        }
    }
    None
}

fn owner_pid(scratch: &Scratch) -> u32 {
    run_state(scratch)["owner"]["pid"]
        .as_u64()
        .expect("the owner pid") as u32
}

fn peer_pid(scratch: &Scratch) -> u32 {
    run_state(scratch)["peer"]["pid"]
        .as_u64()
        .expect("the peer pid") as u32
}

fn alive(pid: u32) -> bool {
    devboard::supervision::live_process(pid)
}

/// Every live process whose command line names the fixture log, which only the
/// ACP stub a run started uses.
fn children_naming(log: &Path) -> Vec<(u32, String)> {
    let needle = log.display().to_string();
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return found;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(pid) = name.parse::<u32>() else {
            continue;
        };
        if pid == std::process::id() {
            continue;
        }
        let Ok(raw) = std::fs::read(entry.path().join("cmdline")) else {
            continue;
        };
        let argv = String::from_utf8_lossy(&raw).replace('\0', " ");
        if argv.contains(&needle) && alive(pid) {
            found.push((pid, argv));
        }
    }
    found
}

async fn wait_until(condition: impl Fn() -> bool, timeout: Duration, what: &str) {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if condition() {
            return;
        }
        assert!(tokio::time::Instant::now() < deadline, "timed out: {what}");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn streamed(answer: &str) -> String {
    let split = answer
        .find(". ")
        .map(|index| index + 2)
        .expect("the fixture answer has two sentences");
    format!("{}{}", answer[..split].trim(), answer[split..].trim())
}

const ANSWER_ONE: &str = "The issues indicator shows the lifecycle the detached worker published \
                           for this repository. It turns amber while a run is working and shows \
                           failed when the last run failed. It sits in the status bar and opens \
                           the Issues mode.";

fn context() -> Value {
    json!({
        "route": "/issues",
        "url": "http://127.0.0.1:8080/issues",
        "selector": "#issues-indicator",
        "viewport": "1280x800",
        "captured_at": "2026-11-03T12:00:00.000Z",
        "visible_text": "Issues",
        "dom_excerpt": "<button id=\"issues-indicator\">Issues</button>",
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discover_runs_survive_a_replacement_and_stop() {
    let scratch = Scratch::new("discover");
    let repo = fixture_repo(&scratch);
    let state = scratch.state();
    provider(&state);
    let log = scratch.path.join("discover-agent.log");
    let command = format!(
        "{} acp-stub --discover --discover-delay-ms=1500 --discover-question --log={}",
        env!("CARGO_BIN_EXE_devboard"),
        log.display()
    );
    let mut first = spawn_server(&scratch, &command);
    let port = first.listening_port().await;
    let base = first.base();
    wait_ready(&base).await;

    rest(&base, json!({"type": "discoverProject"})).await;
    let workspace = poll_frames(
        &base,
        json!({"type": "getDiscover"}),
        |frame| frame["type"] == "discoverState" && frame["state"]["runId"].is_string(),
        Duration::from_secs(20),
        "the discover run started",
    )
    .await;
    let discover_run = workspace
        .iter()
        .find(|frame| frame["type"] == "discoverState")
        .and_then(|frame| frame["state"]["runId"].as_str())
        .map(str::to_string)
        .expect("a run id");

    wait_until(
        || {
            current_run_state(&scratch).is_some_and(|state| {
                state["peer"].is_object() && state["peer"]["pid"].as_u64().is_some()
            })
        },
        Duration::from_secs(30),
        "the discover owner recorded its peer",
    )
    .await;
    let owner = owner_pid(&scratch);
    let peer = peer_pid(&scratch);
    assert!(alive(owner), "the owner outlives its dashboard");
    assert!(alive(peer), "the peer outlives its dashboard");
    wait_until(
        || {
            std::fs::read_to_string(run_directory(&scratch).join("activity.jsonl"))
                .map(|text| text.contains("Reading the host for sheet"))
                .unwrap_or(false)
        },
        Duration::from_secs(20),
        "the first activity line reached the journal",
    )
    .await;

    // Replace the dashboard through the documented REST restart resource.
    restart(&base).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let mut first = first;
    loop {
        if first.child.try_wait().expect("a status").is_some() {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the replaced dashboard exited"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    wait_ready(&base).await;

    let replayed = poll_frames(
        &base,
        json!({"type": "getDiscover"}),
        |frame| {
            frame["type"] == "discoverState"
                && frame["state"]["runId"] == json!(discover_run)
                && frame["state"]["active"] == json!(true)
        },
        Duration::from_secs(30),
        "the replacement re-attached to the discover run",
    )
    .await;
    let state_frame = replayed
        .iter()
        .find(|frame| frame["type"] == "discoverState")
        .expect("a state frame");
    assert_eq!(state_frame["state"]["activeAgent"], json!("sheet"));
    assert_eq!(
        owner_pid(&scratch),
        owner,
        "the replacement adopts the owner"
    );

    // The run's own socket replays its retained journal from the beginning.
    let id = run_id(&base, &discover_run).await;
    let mut socket = run_socket(port, &id, None).await;
    let retained = frames_until(
        &mut socket,
        |frame| frame["type"] == "question",
        Duration::from_secs(30),
    )
    .await;
    let activity: Vec<&str> = by_type(&retained, "activity")
        .into_iter()
        .filter_map(|frame| frame["text"].as_str())
        .collect();
    assert_eq!(
        activity
            .iter()
            .filter(|text| text.contains("Reading the host for sheet"))
            .count(),
        1,
        "one retained activity line: {retained:?}"
    );
    let question = by_type(&retained, "question")
        .first()
        .copied()
        .expect("a question")
        .clone();
    let question_id = question["question"]["id"].clone();
    for frame in &retained {
        assert_eq!(frame["run"], id, "only this run's frames");
    }

    // The answer reaches the same run, and the operator's Stop ends it.
    rest(
        &base,
        json!({"type": "answerDiscover", "id": question_id, "value": "yes"}),
    )
    .await;
    rest(&base, json!({"type": "stopDiscover"})).await;
    wait_until(
        || {
            std::fs::read_to_string(&log)
                .map(|text| text.contains("answer yes"))
                .unwrap_or(false)
        },
        Duration::from_secs(20),
        "the answer reached the same run",
    )
    .await;
    wait_until(|| !alive(owner), Duration::from_secs(20), "the owner ended").await;
    wait_until(
        || !alive(peer),
        Duration::from_secs(20),
        "the ACP peer ended",
    )
    .await;
    wait_until(
        || children_naming(&log).is_empty(),
        Duration::from_secs(20),
        "no ACP child survived the replacement",
    )
    .await;

    let stopped_state = run_state(&scratch);
    assert_eq!(stopped_state["status"], "stopped");
    let workspace: Value = reqwest::Client::new()
        .get(format!("{base}/discoveries/workspace"))
        .header("accept", "application/json")
        .send()
        .await
        .expect("a workspace read")
        .json()
        .await
        .expect("JSON");
    if let Some(state) = workspace["frames"]
        .as_array()
        .and_then(|frames| frames.iter().find(|frame| frame["type"] == "discoverState"))
    {
        assert!(state["state"]["runId"].is_null(), "{workspace}");
    }
    let directory = run_directory(&scratch);
    assert!(directory.join("activity.jsonl").is_file());

    // End the replacement dashboard itself.
    if let Some(lease) = devboard::detached_run::read_detached_lease(&state_path(&scratch), &repo) {
        unsafe {
            libc::kill(lease.pid as libc::pid_t, libc::SIGTERM);
        }
    }
}

fn state_path(scratch: &Scratch) -> PathBuf {
    scratch.state()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ask_runs_survive_a_replacement_with_one_ask_done() {
    let scratch = Scratch::new("ask");
    let repo = fixture_repo(&scratch);
    let state = scratch.state();
    provider(&state);
    let log = scratch.path.join("ask-agent.log");
    let command = format!(
        "{} acp-stub --ask --ask-delay-ms=2500 --log={}",
        env!("CARGO_BIN_EXE_devboard"),
        log.display()
    );
    let mut first = spawn_server(&scratch, &command);
    let port = first.listening_port().await;
    let base = first.base();
    wait_ready(&base).await;

    let request = json!({
        "type": "ask",
        "conversationId": "conversation-1",
        "question": "What does the issues indicator show?",
        "context": context(),
    });
    // The ask keeps its request open for the turn; the restart below runs on
    // its own connection, exactly like the updater's control path.
    let base_for_ask = base.clone();
    let ask_request = request.clone();
    let ask = tokio::spawn(async move { rest(&base_for_ask, ask_request).await });
    wait_until(
        || {
            current_run_state(&scratch)
                .is_some_and(|state| state["peer"].is_object() && state["turnSeq"] == json!(0))
        },
        Duration::from_secs(30),
        "the ask owner recorded its peer",
    )
    .await;

    restart(&base).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let mut first = first;
    loop {
        if first.child.try_wait().expect("a status").is_some() {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the replaced dashboard exited"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let _ = ask.await;
    wait_ready(&base).await;
    // The page asks again after reconnecting; the owner already has the turn.
    let _ = rest(&base, request.clone()).await;

    // The replacement attaches to the same run and the run's socket replays
    // its retained assistant text and terminal turn state.
    let id = run_id(&base, "conversation-1").await;
    let mut socket = run_socket(port, &id, None).await;
    let frames = frames_until(
        &mut socket,
        |frame| frame["type"] == "state" && frame["state"]["turnStatus"] == json!("succeeded"),
        Duration::from_secs(60),
    )
    .await;
    let answer: String = by_type(&frames, "text")
        .into_iter()
        .filter_map(|frame| frame["text"].as_str())
        .collect();
    assert_eq!(
        answer,
        streamed(ANSWER_ONE),
        "the streamed answer arrives once"
    );
    assert!(
        by_type(&frames, "stderr").is_empty(),
        "the attached turn carries no error: {frames:?}"
    );
    for frame in &frames {
        assert_eq!(frame["run"], id, "only this run's frames");
    }

    let transcript_path = state
        .join("ask")
        .join(devboard::journal::journal_key(&repo))
        .join(format!(
            "{}.json",
            &hex::encode(sha2::Sha256::digest(b"conversation-1"))[..32]
        ));
    wait_until(
        || {
            std::fs::read_to_string(&transcript_path)
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                .and_then(|value| {
                    value["transcript"]
                        .as_array()
                        .map(|entries| entries.len() == 2)
                })
                .unwrap_or(false)
        },
        Duration::from_secs(20),
        "the turn's answer reached the transcript",
    )
    .await;
    let conversation = std::fs::read_to_string(&transcript_path).expect("the transcript exists");
    let transcript: Value = serde_json::from_str(&conversation).expect("JSON");
    let entries = transcript["transcript"].as_array().expect("entries");
    assert_eq!(
        entries.len(),
        2,
        "one question and one answer: {transcript}"
    );
    assert_eq!(entries[0]["role"], "developer");
    assert_eq!(entries[1]["role"], "agent");
    assert_eq!(entries[1]["text"], json!(streamed(ANSWER_ONE)));
    assert_eq!(transcript["busy"], json!(false));

    // Closing the conversation ends the owner and its peer.
    let owner = {
        let directory = scratch
            .state()
            .join("runs")
            .join(devboard::journal::journal_key(&repo))
            .read_dir()
            .expect("the runs root")
            .flatten()
            .map(|entry| entry.path())
            .find(|path| path.join("state.json").is_file())
            .expect("an ask run directory");
        let value: Value = serde_json::from_str(
            &std::fs::read_to_string(directory.join("state.json")).expect("a state"),
        )
        .expect("JSON");
        let owner = value["owner"]["pid"].as_u64().expect("the owner pid") as u32;
        let peer = value["peer"]["pid"].as_u64().expect("the peer pid") as u32;
        assert!(alive(owner));
        assert!(
            alive(peer),
            "the peer survives until the conversation closes"
        );
        owner
    };
    rest(
        &base,
        json!({"type": "closeAsk", "conversationId": "conversation-1"}),
    )
    .await;
    wait_until(
        || !alive(owner),
        Duration::from_secs(20),
        "the ask owner ended",
    )
    .await;
    wait_until(
        || children_naming(&log).is_empty(),
        Duration::from_secs(20),
        "no ACP child survived the replacement",
    )
    .await;

    if let Some(lease) = devboard::detached_run::read_detached_lease(&state, &repo) {
        unsafe {
            libc::kill(lease.pid as libc::pid_t, libc::SIGTERM);
        }
    }
}

/// One Issues run record plus its activity file: the durable source the
/// collection and the output sockets read.
fn seed_issue_run(scratch: &Scratch, id: &str, status: &str, worker_pid: u32) -> PathBuf {
    let repo = scratch.repo();
    let directory = scratch
        .state()
        .join("issues")
        .join(devboard::journal::journal_key(&repo))
        .join("runs")
        .join(id);
    write(
        &directory.join("run.json"),
        &format!(
            "{}\n",
            json!({
                "version": 1,
                "runId": id,
                "repo": "fixture",
                "status": status,
                "workerPid": worker_pid,
                "startedAt": "2026-11-10T00:00:00.000Z",
                "harnessVersion": "1.0.0",
            })
        ),
    );
    write(
        &directory.join("activity.json"),
        &format!("{}\n", json!(["one", "two"])),
    );
    directory
}

fn file_identity(path: &Path) -> (Vec<u8>, std::time::SystemTime) {
    let text = std::fs::read(path).expect("a record");
    let modified = std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .expect("a modification time");
    (text, modified)
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn four_sockets_read_one_run_once_per_interval() {
    let scratch = Scratch::new("sample");
    let _repo = fixture_repo(&scratch);
    let directory = seed_issue_run(&scratch, "fixture", "running", std::process::id());
    let mut server = spawn_server(&scratch, "true");
    let port = server.listening_port().await;
    let base = server.base();
    wait_ready(&base).await;
    // The collection read happens before the watch: only the sockets are
    // measured.
    let id = run_id(&base, "fixture").await;
    let watcher = AccessCounter::watch(&directory);

    let mut sockets = Vec::new();
    for _ in 0..4 {
        sockets.push(run_socket(port, &id, None).await);
    }
    for socket in sockets.iter_mut() {
        let _ = frames_until(
            socket,
            |frame| frame["type"] == "state",
            Duration::from_secs(10),
        )
        .await;
    }
    // Let the first sample settle, then measure five unchanged intervals.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let _ = watcher.take();
    tokio::time::sleep(Duration::from_millis(2_500)).await;
    let counts = watcher.take();
    let run_reads = counts
        .get(&directory.join("run.json"))
        .copied()
        .unwrap_or(0);
    let activity_reads = counts
        .get(&directory.join("activity.json"))
        .copied()
        .unwrap_or(0);
    assert!(
        run_reads <= 5,
        "four sockets sample one run at most once per interval: run.json read {run_reads} times"
    );
    assert!(
        activity_reads <= 5,
        "activity.json read {activity_reads} times"
    );

    // No interval elapses: nothing is read at all.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let quiet = watcher.take();
    assert!(
        quiet.is_empty(),
        "an interval with no sample reads nothing: {quiet:?}"
    );
    drop(sockets);
    if let Some(lease) =
        devboard::detached_run::read_detached_lease(&scratch.state(), &scratch.repo())
    {
        unsafe {
            libc::kill(lease.pid as libc::pid_t, libc::SIGTERM);
        }
    }
    let _ = server.child.kill();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_orphaned_running_record_is_stopped_and_unrewritten() {
    let scratch = Scratch::new("orphan");
    let _repo = fixture_repo(&scratch);
    let directory = seed_issue_run(&scratch, "orphan", "running", 999_995);
    let before = file_identity(&directory.join("run.json"));
    let mut server = spawn_server(&scratch, "true");
    let port = server.listening_port().await;
    let base = server.base();
    wait_ready(&base).await;
    let _ = port;

    let client = reqwest::Client::new();
    let body: Value = client
        .get(format!("{base}/agent-runs"))
        .header("accept", "application/json")
        .send()
        .await
        .expect("a collection")
        .json()
        .await
        .expect("JSON");
    let run = body["runs"]
        .as_array()
        .and_then(|runs| runs.iter().find(|run| run["id"] == json!("issues--orphan")))
        .expect("the orphaned record");
    assert_eq!(run["live"], json!(false), "a dead worker holds no socket");
    assert_eq!(
        run["lifecycle"],
        json!("stopped"),
        "and is reported stopped"
    );

    let body: Value = client
        .get(format!("{base}/agent-runs/issues--orphan"))
        .header("accept", "application/json")
        .send()
        .await
        .expect("a representation")
        .json()
        .await
        .expect("JSON");
    assert_eq!(body["live"], json!(false));
    assert_eq!(body["lifecycle"], json!("stopped"));
    assert_eq!(
        file_identity(&directory.join("run.json")),
        before,
        "the record's bytes and modification time are unchanged"
    );
    if let Some(lease) =
        devboard::detached_run::read_detached_lease(&scratch.state(), &scratch.repo())
    {
        unsafe {
            libc::kill(lease.pid as libc::pid_t, libc::SIGTERM);
        }
    }
    let _ = server.child.kill();
}
