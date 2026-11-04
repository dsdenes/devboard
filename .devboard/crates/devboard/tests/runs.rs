//! Discover and Ask runs survive a dashboard replacement: one detached owner,
//! replayed activity, an answer routed to the same run, Stop, and no orphaned
//! ACP child.

use std::path::{Path, PathBuf};
use std::process::{Child, Command as ProcessCommand, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use devboard::providers::{save_subscriptions, ProviderId, StoredSubscription};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sha2::Digest;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

const TOKEN: &str = "runs-test-token";

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
        .env("DEVBOARD_DASHBOARD_TOKEN", TOKEN)
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
        .bearer_auth(TOKEN)
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

async fn socket(port: u16) -> Socket {
    let mut request = format!("ws://127.0.0.1:{port}/ws")
        .into_client_request()
        .expect("a socket URL");
    request.headers_mut().insert(
        "authorization",
        axum::http::HeaderValue::from_str(&format!("Bearer {TOKEN}")).expect("a token"),
    );
    let (socket, _) = connect_async(request).await.expect("a websocket");
    socket
}

async fn send(socket: &mut Socket, frame: Value) {
    socket
        .send(Message::Text(frame.to_string().into()))
        .await
        .expect("a frame is sent");
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

    let mut socket_a = socket(port).await;
    // Let the fresh dashboard's replay settle.
    let settle = tokio::time::Instant::now() + Duration::from_millis(250);
    while tokio::time::Instant::now() < settle {
        let _ = tokio::time::timeout(Duration::from_millis(50), socket_a.next()).await;
    }
    send(&mut socket_a, json!({"type": "discoverProject"})).await;
    let started = frames_until(
        &mut socket_a,
        |frame| frame["type"] == "discoverStarted",
        Duration::from_secs(20),
    )
    .await;
    let started = started
        .iter()
        .find(|frame| frame["type"] == "discoverStarted")
        .expect("a start frame")
        .clone();
    let run_id = started["runId"].as_str().expect("a run id").to_string();
    let first_activity = frames_until(
        &mut socket_a,
        |frame| {
            frame["type"] == "discoverActivity"
                && frame["text"]
                    .as_str()
                    .is_some_and(|text| text.contains("Reading the host for sheet"))
        },
        Duration::from_secs(20),
    )
    .await;
    assert!(!first_activity.is_empty());

    let owner = owner_pid(&scratch);
    let peer = peer_pid(&scratch);
    assert!(alive(owner), "the owner outlives its dashboard");
    assert!(alive(peer), "the peer outlives its dashboard");

    // Replace the dashboard through the launcher the restart command uses.
    send(&mut socket_a, json!({"type": "restartServer"})).await;
    drop(socket_a);
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

    let mut socket_b = socket(port).await;
    let replayed = frames_until(
        &mut socket_b,
        |frame| frame["type"] == "discoverQuestion",
        Duration::from_secs(30),
    )
    .await;
    let starts: Vec<&Value> = by_type(&replayed, "discoverStarted");
    assert!(
        starts.iter().any(|frame| frame["runId"] == json!(run_id)),
        "the replacement replays the same run: {replayed:?}"
    );
    let replayed_activity: Vec<&str> = by_type(&replayed, "discoverActivity")
        .into_iter()
        .filter_map(|frame| frame["text"].as_str())
        .collect();
    assert_eq!(
        replayed_activity
            .iter()
            .filter(|text| text.contains("Reading the host for sheet"))
            .count(),
        1,
        "one replayed activity line: {replayed:?}"
    );
    let replayed_states = by_type(&replayed, "discoverState");
    assert!(
        replayed_states.iter().any(|frame| {
            frame["state"]["active"] == json!(true)
                && frame["state"]["runId"] == json!(run_id)
                && frame["state"]["activeAgent"] == json!("sheet")
        }),
        "the reconnected page sees the live run: {replayed:?}"
    );
    let question = by_type(&replayed, "discoverQuestion")
        .first()
        .copied()
        .expect("a question")
        .clone();
    let question_id = question["id"].clone();
    assert_eq!(
        owner_pid(&scratch),
        owner,
        "the replacement adopts the owner"
    );

    // The answer reaches the same run, and the operator's Stop ends it.
    send(
        &mut socket_b,
        json!({"type": "answerDiscover", "id": question_id, "value": "yes"}),
    )
    .await;
    send(&mut socket_b, json!({"type": "stopDiscover"})).await;
    let stopped = frames_until(
        &mut socket_b,
        |frame| frame["type"] == "discoverStopped",
        Duration::from_secs(30),
    )
    .await;
    assert!(by_type(&stopped, "discoverStopped")
        .iter()
        .any(|frame| frame["completed"] == json!(false)));

    // The stub logs the value it received, proving the answer reached the
    // same run the replacement re-attached to.
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

    let state = run_state(&scratch);
    assert_eq!(state["status"], "stopped");
    assert_eq!(state["runId"], Value::Null, "no live Discover run remains");
    let directory = run_directory(&scratch);
    assert!(directory.join("activity.jsonl").is_file());
    let activity = std::fs::read_to_string(directory.join("activity.jsonl")).expect("activity");
    assert!(activity.contains("Reading the host for sheet"));

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
    let mut socket_a = socket(port).await;
    let settle = tokio::time::Instant::now() + Duration::from_millis(250);
    while tokio::time::Instant::now() < settle {
        let _ = tokio::time::timeout(Duration::from_millis(50), socket_a.next()).await;
    }
    send(&mut socket_a, request.clone()).await;
    // The ask holds its socket until the turn settles, so this page cannot
    // report its first chunk yet. Wait for the owner to record its peer, which
    // is the same state a replacement would find.
    wait_until(
        || {
            current_run_state(&scratch)
                .is_some_and(|state| state["peer"].is_object() && state["turnSeq"] == json!(0))
        },
        Duration::from_secs(30),
        "the ask owner recorded its peer",
    )
    .await;

    // The ask command holds its own socket while the turn runs, so the
    // replacement is requested through a second page, exactly like the
    // updater's own control connection.
    let mut control = socket(port).await;
    send(&mut control, json!({"type": "restartServer"})).await;
    // Keep the control page connected until the old dashboard exits: its
    // replay must be delivered before the queued restart can be read.
    drop(socket_a);
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
    drop(control);
    wait_ready(&base).await;

    // The page asks again after reconnecting; the owner already has the turn.
    let mut socket_b = socket(port).await;
    send(&mut socket_b, request).await;
    let frames = frames_until(
        &mut socket_b,
        |frame| frame["type"] == "askDone",
        Duration::from_secs(60),
    )
    .await;
    let done = by_type(&frames, "askDone");
    assert_eq!(done.len(), 1, "askDone exactly once: {frames:?}");
    assert_eq!(done[0]["conversationId"], "conversation-1");
    assert!(
        by_type(&frames, "askError").is_empty(),
        "the attached turn carries no error: {frames:?}"
    );
    let answer: String = by_type(&frames, "askChunk")
        .into_iter()
        .filter_map(|frame| frame["text"].as_str())
        .collect();
    assert_eq!(
        answer,
        streamed(ANSWER_ONE),
        "the streamed answer arrives once"
    );

    let conversation = std::fs::read_to_string(
        state
            .join("ask")
            .join(devboard::journal::journal_key(&repo))
            .join(format!(
                "{}.json",
                &hex::encode(sha2::Sha256::digest(b"conversation-1"))[..32]
            )),
    )
    .expect("the transcript exists");
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
    send(
        &mut socket_b,
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
