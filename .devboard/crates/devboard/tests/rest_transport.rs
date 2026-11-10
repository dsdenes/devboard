//! The REST transport and the per-run output sockets.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use devboard::config::Config;
use devboard::detached_run::{
    append_detached_run_activity, append_detached_run_text, detached_run_directory,
    write_detached_run_state, DetachedRunActivity, DetachedRunState, DetachedRunStatus,
};
use devboard::http::Server;
use devboard::journal::Journal;
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT_ENCODING, HOST, IF_NONE_MATCH, ORIGIN};
use reqwest::Method;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

const RETIRED_COMMANDS: [&str; 80] = [
    "listRecords",
    "getGoal",
    "getProject",
    "getVersion",
    "getMcpTools",
    "getInstalledSkills",
    "getComplexity",
    "getResources",
    "setResources",
    "setInstalledSkillEnabled",
    "getIssues",
    "getIssuesRun",
    "startIssues",
    "pauseIssues",
    "resumeIssues",
    "stopIssues",
    "checkIssues",
    "answerIssues",
    "closeIssue",
    "getGoalDrafts",
    "getGoalDraft",
    "startGoalDraft",
    "stopGoalDraft",
    "deleteGoalDraft",
    "answerGoalDraft",
    "getAgents",
    "getAgent",
    "refreshAgent",
    "startAgent",
    "stopAgent",
    "setAgentSettings",
    "disableAgentTimer",
    "getAgentPrompt",
    "restartServer",
    "startRun",
    "startLifecycle",
    "stopLifecycle",
    "pauseLifecycle",
    "resumeLifecycle",
    "reviseGoal",
    "createGoal",
    "prepareSkills",
    "getSkills",
    "deleteSkill",
    "resetImplementation",
    "createFlowGoal",
    "cancelFlowGoal",
    "startFlowImplementation",
    "stopFlowImplementation",
    "retryFlowPr",
    "markFlowPrReady",
    "mergeFlowPr",
    "sendFlowSteering",
    "acceptFlowWidget",
    "refuseFlowWidget",
    "openFlowWidget",
    "closeFlowWidget",
    "sendFlowConversation",
    "sendFlowConclusion",
    "dismissFlowBlocker",
    "flowAnswer",
    "answer",
    "discoverProject",
    "discoverAgent",
    "discoverRemote",
    "switchDiscoverRemote",
    "removeDiscoverRemote",
    "clearDiscoverRemote",
    "stopDiscover",
    "answerDiscover",
    "getDiscover",
    "confirmGlossaryTerm",
    "rejectGlossaryTerm",
    "ask",
    "closeAsk",
    "getProviders",
    "saveProvider",
    "deleteProvider",
    "setProviderEnabled",
    "refreshProviders",
];

struct Instance {
    base: String,
    port: u16,
    state: PathBuf,
    repo: PathBuf,
    server: std::sync::Arc<Server>,
}

fn harness_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the harness directory exists")
}

fn scratch(label: &str) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("a clock")
        .as_nanos();
    let root = harness_root().join(".test-tmp").join(format!(
        "rest-{label}-{}-{nanos}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(root.join("state")).expect("a state directory");
    std::fs::create_dir_all(root.join("repo/adrs")).expect("a repository");
    root
}

async fn start(label: &str) -> Instance {
    let root = scratch(label);
    let repo = root.join("repo");
    let state = root.join("state");
    let config = Config {
        hostname: "127.0.0.1".to_string(),
        port: 0,
        adrs_dir: repo.join("adrs"),
        repo_dir: repo.clone(),
        goal_file: repo.join("GOAL.md"),
        static_dir: None,
        agent_command: "true".to_string(),
        state_dir: state.clone(),
        allowed_hosts: Vec::new(),
        feedback: None,
    };
    let listener = devboard::http::bind(&config.hostname, 0)
        .await
        .expect("a listener");
    let port = listener.local_addr().expect("an address").port();
    let mut config = config;
    config.port = port;
    let journal = Journal::open(&config.state_dir, &config.repo_dir, config.port);
    let server = Server::new(config, journal);
    let served = std::sync::Arc::clone(&server);
    tokio::spawn(async move {
        let _ = devboard::http::serve_on(listener, served).await;
    });
    Instance {
        base: format!("http://127.0.0.1:{port}"),
        port,
        state,
        repo,
        server,
    }
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_gzip()
        .build()
        .expect("a client")
}

fn headers_with(name: reqwest::header::HeaderName, value: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(name, HeaderValue::from_str(value).expect("a header value"));
    headers
}

async fn send(
    base: &str,
    method: Method,
    path: &str,
    headers: HeaderMap,
) -> (reqwest::StatusCode, HeaderMap, Vec<u8>) {
    let response = client()
        .request(method, format!("{base}{path}"))
        .headers(headers)
        .send()
        .await
        .expect("a response");
    let status = response.status();
    let headers = response.headers().clone();
    let body = response.bytes().await.expect("a body").to_vec();
    (status, headers, body)
}

async fn send_json(
    base: &str,
    method: Method,
    path: &str,
    body: Value,
) -> (reqwest::StatusCode, HeaderMap, Vec<u8>) {
    let response = client()
        .request(method, format!("{base}{path}"))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body.to_string())
        .send()
        .await
        .expect("a response");
    let status = response.status();
    let headers = response.headers().clone();
    let body = response.bytes().await.expect("a body").to_vec();
    (status, headers, body)
}

/// The frames an answer carries, in order.
fn frames(body: &[u8]) -> Vec<Value> {
    serde_json::from_slice::<Value>(body)
        .expect("a JSON envelope")
        .get("frames")
        .and_then(Value::as_array)
        .cloned()
        .expect("a frames array")
}

/// The frame types an answer carries, in order.
fn frame_types(body: &[u8]) -> Vec<String> {
    frames(body)
        .iter()
        .filter_map(|frame| frame.get("type").and_then(Value::as_str))
        .map(str::to_string)
        .collect()
}

fn number(value: &Value) -> u64 {
    value.as_u64().expect("a cursor")
}

fn run_state(
    kind: &str,
    key: &str,
    status: DetachedRunStatus,
    state_dir: &Path,
    repo: &Path,
) -> DetachedRunState {
    let now = "2026-11-07T00:00:00.000Z".to_string();
    DetachedRunState {
        version: 1,
        kind: kind.to_string(),
        key: key.to_string(),
        repo: repo.display().to_string(),
        state_dir: state_dir.display().to_string(),
        harness_version: None,
        instance: "rest-transport-test".to_string(),
        launcher_pid: None,
        generation: "generation-1".to_string(),
        multi: false,
        turn_seq: None,
        turn_status: None,
        turn_error: None,
        status,
        started_at: now.clone(),
        finished_at: None,
        error: None,
        question: None,
        owner: None,
        peer: None,
        updated_at: now,
    }
}

fn make_run(
    instance: &Instance,
    kind: &str,
    key: &str,
    status: DetachedRunStatus,
) -> (String, PathBuf) {
    let directory = detached_run_directory(&instance.state, &instance.repo, kind, key);
    std::fs::create_dir_all(&directory).expect("a run directory");
    let state = run_state(kind, key, status, &instance.state, &instance.repo);
    write_detached_run_state(&directory, &state).expect("a run state");
    let id = directory
        .file_name()
        .expect("a directory name")
        .to_string_lossy()
        .into_owned();
    (id, directory)
}

async fn socket(
    port: u16,
    id: &str,
    after: Option<u64>,
) -> WebSocketStream<MaybeTlsStream<TcpStream>> {
    let query = after
        .map(|cursor| format!("?after={cursor}"))
        .unwrap_or_default();
    let request = format!("ws://127.0.0.1:{port}/agent-runs/{id}/output{query}")
        .into_client_request()
        .expect("a socket URL");
    connect_async(request).await.expect("a run socket").0
}

async fn collect(
    socket: &mut WebSocketStream<MaybeTlsStream<TcpStream>>,
    duration: Duration,
) -> Vec<Value> {
    let deadline = tokio::time::Instant::now() + duration;
    let mut frames = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match tokio::time::timeout(remaining, socket.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                if let Ok(frame) = serde_json::from_str::<Value>(&text) {
                    frames.push(frame);
                }
            }
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) => break,
            Ok(Some(Ok(_))) => continue,
            Ok(Some(Err(_))) => break,
            Err(_) => break,
        }
    }
    frames
}

fn assert_problem(status: reqwest::StatusCode, headers: &HeaderMap, body: &[u8], expected: u16) {
    assert_eq!(status.as_u16(), expected, "status");
    assert_eq!(
        headers
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
        Some("application/problem+json"),
        "content type"
    );
    let value: Value = serde_json::from_slice(body).expect("a problem body");
    assert_eq!(value["type"], "about:blank");
    assert!(value["title"].is_string());
    assert_eq!(value["status"], expected);
    assert!(value["detail"].is_string());
}

#[tokio::test]
async fn provider_creation_posts_to_the_collection() {
    let instance = start("provider-create").await;
    let response = client()
        .post(format!("{}/providers", instance.base))
        .header("content-type", "application/json")
        .body(
            json!({
                "requestId": 1,
                "provider": "unknown",
                "label": "main",
                "key": "sk-test",
            })
            .to_string(),
        )
        .send()
        .await
        .expect("a response");
    assert_eq!(response.status().as_u16(), 201);
    assert!(
        response.headers().get(reqwest::header::LOCATION).is_some(),
        "a creation names the collection"
    );
    let body: Value = response.json().await.expect("a JSON body");
    let frames = body["frames"].as_array().expect("frames");
    assert_eq!(frames[0]["type"], "providerError");
    assert_eq!(frames[0]["requestId"], 1);
    assert_eq!(frames[0]["message"], "Choose OpenCode Go or OpenRouter.");
}

#[tokio::test]
async fn retired_command_frames_change_no_state() {
    let instance = start("retired").await;
    let state_path = devboard::state::state_file(&instance.state, &instance.repo);
    let before = std::fs::read(&state_path).ok();
    let before_runs = std::fs::read_dir(instance.state.join("runs"))
        .map(|entries| entries.flatten().count())
        .unwrap_or(0);
    let frames = [
        json!({"type": "startIssues"}),
        json!({"type": "createGoal"}),
        json!({"type": "setResources", "maxAgentPeers": 2}),
        json!({"type": "startFlowImplementation"}),
        json!({"type": "discoverProject"}),
        json!({"type": "unknownCommand"}),
    ];
    for frame in frames {
        let response = client()
            .post(format!("{}/ws", instance.base))
            .header("content-type", "application/json")
            .body(frame.to_string())
            .send()
            .await
            .expect("a response");
        assert_eq!(response.status().as_u16(), 404);
        assert_eq!(
            response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
            Some("application/problem+json")
        );
    }
    // An upgrade request to the retired path executes nothing either.
    let mut stream = TcpStream::connect(("127.0.0.1", instance.port))
        .await
        .expect("a connection");
    let request = format!(
        "GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
        instance.port
    );
    stream
        .write_all(request.as_bytes())
        .await
        .expect("an upgrade request");
    let mut response = vec![0u8; 4096];
    let read = tokio::time::timeout(Duration::from_secs(2), stream.read(&mut response))
        .await
        .expect("a response")
        .expect("a read");
    let text = String::from_utf8_lossy(&response[..read]);
    assert!(text.starts_with("HTTP/1.1 404"), "got {text}");
    assert!(text
        .to_ascii_lowercase()
        .contains("application/problem+json"));
    let after = std::fs::read(&state_path).ok();
    let after_runs = std::fs::read_dir(instance.state.join("runs"))
        .map(|entries| entries.flatten().count())
        .unwrap_or(0);
    assert_eq!(before, after, "the state file is byte-identical");
    assert_eq!(before_runs, after_runs, "no run was created");
}

#[tokio::test]
async fn run_sockets_are_isolated_per_run() {
    let instance = start("isolate").await;
    let (a, _) = make_run(&instance, "flow", "a", DetachedRunStatus::Running);
    let (b, _) = make_run(&instance, "flow", "b", DetachedRunStatus::Running);
    append_detached_run_activity(
        &detached_run_directory(&instance.state, &instance.repo, "flow", "a"),
        &DetachedRunActivity {
            text: "A line".to_string(),
            append: false,
        },
    );
    append_detached_run_activity(
        &detached_run_directory(&instance.state, &instance.repo, "flow", "b"),
        &DetachedRunActivity {
            text: "B line".to_string(),
            append: false,
        },
    );
    let mut first_a = socket(instance.port, &a, None).await;
    let mut second_a = socket(instance.port, &a, None).await;
    let mut socket_b = socket(instance.port, &b, None).await;
    let frames_a = collect(&mut first_a, Duration::from_millis(500)).await;
    let frames_a2 = collect(&mut second_a, Duration::from_millis(500)).await;
    let frames_b = collect(&mut socket_b, Duration::from_millis(500)).await;
    assert!(!frames_a.is_empty());
    assert!(!frames_b.is_empty());
    for frame in &frames_a {
        assert_eq!(frame["run"], a);
        assert_ne!(frame["run"], b);
    }
    for frame in &frames_b {
        assert_eq!(frame["run"], b);
        assert_ne!(frame["run"], a);
    }
    let a_texts: Vec<String> = frames_a
        .iter()
        .filter(|frame| frame["type"] == "activity")
        .filter_map(|frame| frame["text"].as_str().map(str::to_string))
        .collect();
    let b_texts: Vec<String> = frames_b
        .iter()
        .filter(|frame| frame["type"] == "activity")
        .filter_map(|frame| frame["text"].as_str().map(str::to_string))
        .collect();
    assert!(a_texts.iter().any(|text| text == "A line"));
    assert!(!a_texts.iter().any(|text| text == "B line"));
    assert!(b_texts.iter().any(|text| text == "B line"));
    assert!(!b_texts.iter().any(|text| text == "A line"));
    let cursors_a: Vec<u64> = frames_a
        .iter()
        .filter_map(|frame| frame.get("cursor").map(number))
        .collect();
    let cursors_a2: Vec<u64> = frames_a2
        .iter()
        .filter_map(|frame| frame.get("cursor").map(number))
        .collect();
    assert_eq!(cursors_a, cursors_a2, "two sockets for one run agree");
}

#[tokio::test]
async fn run_socket_frame_allowlist() {
    let instance = start("allowlist").await;
    let (id, directory) = make_run(&instance, "flow", "allow", DetachedRunStatus::Running);
    let mut state = run_state(
        "flow",
        "allow",
        DetachedRunStatus::Running,
        &instance.state,
        &instance.repo,
    );
    state.question = Some(devboard::acp::AcpQuestion {
        id: devboard::acp::AcpId::Number(1),
        message: "Choose".to_string(),
        options: Vec::new(),
        properties: serde_json::Map::new(),
        required: None,
    });
    write_detached_run_state(&directory, &state).expect("the state");
    append_detached_run_activity(
        &directory,
        &DetachedRunActivity {
            text: "one".to_string(),
            append: false,
        },
    );
    append_detached_run_text(&directory, "assistant text");
    let mut socket = socket(instance.port, &id, None).await;
    let frames = collect(&mut socket, Duration::from_millis(600)).await;
    assert!(!frames.is_empty());
    let mut last_cursor = 0;
    for frame in &frames {
        assert_eq!(frame["run"], id);
        let kind = frame["type"].as_str().expect("a frame type");
        assert!(
            matches!(
                kind,
                "state" | "question" | "activity" | "text" | "stderr" | "status"
            ),
            "unexpected frame kind {kind}"
        );
        if kind == "state" {
            let state = frame["state"].as_object().expect("a state object");
            for key in state.keys() {
                assert!(
                    matches!(
                        key.as_str(),
                        "kind"
                            | "key"
                            | "status"
                            | "turnStatus"
                            | "turnError"
                            | "startedAt"
                            | "finishedAt"
                            | "updatedAt"
                            | "harnessVersion"
                            | "error"
                            | "question"
                    ),
                    "state key {key} is not run state"
                );
            }
        }
        if kind == "question" {
            assert!(frame["question"].is_object());
        }
        if kind == "activity" {
            assert!(frame["text"].is_string());
            assert!(frame["append"].is_boolean());
        }
        if kind == "text" || kind == "stderr" {
            assert!(frame["text"].is_string());
        }
        if kind == "status" {
            assert!(frame["status"].is_string());
        }
        let cursor = frame["cursor"].as_u64().expect("an output cursor");
        assert!(cursor > last_cursor, "cursors increase");
        last_cursor = cursor;
    }
    for forbidden in [
        "version",
        "replacement",
        "project",
        "providers",
        "resources",
        "skills",
        "records",
        "issues",
        "drafts",
        "goal",
        "agents",
        "output",
    ] {
        assert!(
            !frames.iter().any(|frame| frame.get(forbidden).is_some()),
            "no frame carries {forbidden}"
        );
    }
}

#[tokio::test]
async fn run_socket_replays_from_cursor() {
    let instance = start("cursor").await;
    let (id, directory) = make_run(&instance, "flow", "cursor", DetachedRunStatus::Running);
    for index in 0..5 {
        append_detached_run_activity(
            &directory,
            &DetachedRunActivity {
                text: format!("line {index}"),
                append: false,
            },
        );
    }
    let mut first = socket(instance.port, &id, None).await;
    let all = collect(&mut first, Duration::from_millis(500)).await;
    assert!(all.len() >= 6);
    let last = all
        .iter()
        .filter_map(|frame| frame.get("cursor").and_then(Value::as_u64))
        .max()
        .expect("a cursor");
    let mut second = socket(instance.port, &id, Some(last)).await;
    let continued = collect(&mut second, Duration::from_millis(400)).await;
    for frame in &continued {
        assert!(number(&frame["cursor"]) > last, "no duplicate and no gap");
    }
    // A cursor older than the retained window answers one reset marker.
    for index in 5..(devboard::runs::RUN_OUTPUT_WINDOW + 10) {
        append_detached_run_activity(
            &directory,
            &DetachedRunActivity {
                text: format!("line {index}"),
                append: false,
            },
        );
    }
    let mut third = socket(instance.port, &id, Some(1)).await;
    let reset_frames = collect(&mut third, Duration::from_millis(600)).await;
    let reset = reset_frames
        .iter()
        .find(|frame| frame["type"] == "reset")
        .expect("a reset marker");
    assert_eq!(reset["run"], id);
    let start = number(&reset["cursor"]);
    assert!(start > 1, "the retained window start is named");
    let retained = reset_frames
        .iter()
        .find(|frame| frame["type"] == "activity")
        .expect("a retained entry");
    assert_eq!(number(&retained["cursor"]), start);
}

#[tokio::test]
async fn every_retired_command_has_an_http_operation() {
    let path = harness_root().join("contract/command-map.json");
    let text = std::fs::read_to_string(&path).expect("the command map");
    let value: Value = serde_json::from_str(&text).expect("JSON");
    let map = value["commands"].as_object().expect("commands");
    let names: BTreeSet<&str> = map.keys().map(String::as_str).collect();
    let expected: BTreeSet<&str> = RETIRED_COMMANDS.iter().copied().collect();
    assert_eq!(
        names, expected,
        "the map names exactly the retired commands"
    );
    assert_eq!(map.len(), 80);
    let routes: BTreeMap<&str, (&str, &str)> = devboard::rest::ROUTES
        .iter()
        .map(|route| (route.command, (route.method.as_str(), route.path)))
        .collect();
    let openapi = std::fs::read_to_string(harness_root().join("openapi.yaml")).expect("openapi");
    let document: Value = serde_yaml::from_str(&openapi).expect("valid YAML");
    let paths = document["paths"].as_object().expect("paths");
    for (name, entry) in map {
        let method = entry["method"].as_str().expect("a method");
        let route_path = entry["path"].as_str().expect("a path");
        assert!(!route_path.contains("/ws"), "no command maps at a socket");
        assert_eq!(
            routes.get(name.as_str()),
            Some(&(method, route_path)),
            "{name} names a served operation"
        );
        let operation = paths
            .get(route_path)
            .and_then(|path| path.get(method.to_ascii_lowercase()))
            .unwrap_or_else(|| panic!("{method} {route_path} is documented for {name}"));
        assert_eq!(operation["operationId"], name.as_str());
    }
}

#[tokio::test]
async fn rest_route_inventory_matches_openapi() {
    let openapi = std::fs::read_to_string(harness_root().join("openapi.yaml")).expect("openapi");
    let document: Value = serde_yaml::from_str(&openapi).expect("valid YAML");
    assert_eq!(document["openapi"], "3.1.0");
    assert!(document["info"]["title"].is_string());
    assert!(document["info"]["version"].is_string());
    assert!(document["info"]["description"].is_string());
    assert!(document["info"]["contact"]["name"].is_string());
    assert!(document["info"]["x-api-id"].is_string());
    assert!(document["info"]["x-audience"].is_string());
    assert!(document["info"]["x-access-model"]
        .as_str()
        .unwrap_or_default()
        .contains("loopback"));
    let mut documented: BTreeSet<(String, String)> = BTreeSet::new();
    for (path, item) in document["paths"].as_object().expect("paths") {
        for (method, operation) in item.as_object().expect("a path object") {
            if method == "parameters" || method == "summary" || method == "description" {
                continue;
            }
            assert!(
                operation["responses"].as_object().is_some(),
                "{method} {path} carries responses"
            );
            documented.insert((path.clone(), method.to_ascii_uppercase()));
        }
    }
    let mut served: BTreeSet<(String, String)> = BTreeSet::new();
    for route in devboard::rest::ROUTES {
        served.insert((route.path.to_string(), route.method.as_str().to_string()));
        assert!(documented.contains(&(route.path.to_string(), route.method.as_str().to_string())));
    }
    for (path, method) in [
        ("/reports", "POST"),
        ("/reports/{id}", "GET"),
        ("/ready", "GET"),
        ("/ready", "HEAD"),
        ("/goal-proposals", "POST"),
        ("/goal-proposals/{name}", "GET"),
        ("/goal-proposals/{name}", "HEAD"),
        ("/agent-runs", "GET"),
        ("/agent-runs", "HEAD"),
        ("/agent-runs/{run_id}", "GET"),
        ("/agent-runs/{run_id}", "HEAD"),
        ("/agent-runs/{run_id}/output", "GET"),
        ("/flows", "GET"),
        ("/flows", "HEAD"),
    ] {
        served.insert((path.to_string(), method.to_string()));
        assert!(
            documented.contains(&(path.to_string(), method.to_string())),
            "{method} {path} is documented"
        );
    }
    assert_eq!(documented, served, "no extra and no missing route");
    assert!(!documented.contains(&("/ws".to_string(), "GET".to_string())));
    assert!(!documented.contains(&("/feedback".to_string(), "POST".to_string())));
    let verbs = [
        "start", "stop", "get", "list", "set", "delete", "create", "send", "answer", "refresh",
        "restart", "pause", "resume", "check", "merge", "retry", "mark", "open", "close", "accept",
        "refuse", "dismiss", "discover", "switch", "remove", "clear", "confirm", "reject", "save",
        "ask", "prepare", "revise", "reset", "cancel",
    ];
    for route in devboard::rest::ROUTES {
        assert!(!route.path.starts_with("/api"));
        assert!(!route.path.ends_with('/'));
        for segment in route.path.trim_start_matches('/').split('/') {
            if segment.starts_with('{') {
                continue;
            }
            assert!(
                segment
                    .chars()
                    .all(|character| character.is_ascii_lowercase()
                        || character.is_ascii_digit()
                        || character == '-'),
                "segment {segment} is lower-kebab-case"
            );
            assert!(!verbs.contains(&segment), "segment {segment} is not a verb");
        }
    }
    for (path, _) in &documented {
        for segment in path.trim_start_matches('/').split('/') {
            if segment.starts_with('{') {
                continue;
            }
            assert!(!verbs.contains(&segment), "path {path} is verb-free");
        }
    }
}

/// Every GET answers only the frames of the command it names, even while a
/// fixture keeps publishing `issuesState` and `issuesActivity` through the
/// shared broadcast. A mutation whose answer travels through that same
/// broadcast still returns its own frames.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn request_frames_are_only_the_named_command_s_frames() {
    let instance = start("request-frames").await;
    let app = std::sync::Arc::clone(&instance.server.app);
    let broadcaster = tokio::spawn(async move {
        for index in 0..500u64 {
            app.broadcast(json!({"type": "issuesState", "issues": [], "index": index}));
            app.broadcast(json!({
                "type": "issuesActivity",
                "runId": format!("foreign-{index}"),
                "entries": [],
            }));
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    });

    for _ in 0..20 {
        let (status, _, body) =
            send(&instance.base, Method::GET, "/version", HeaderMap::new()).await;
        assert_eq!(status.as_u16(), 200);
        assert_eq!(frame_types(&body), vec!["versionState"]);

        let (status, _, body) =
            send(&instance.base, Method::GET, "/agents", HeaderMap::new()).await;
        assert_eq!(status.as_u16(), 200);
        assert_eq!(frame_types(&body), vec!["agentsState"]);

        let (status, _, body) =
            send(&instance.base, Method::GET, "/project", HeaderMap::new()).await;
        assert_eq!(status.as_u16(), 200);
        assert_eq!(frame_types(&body), vec!["project"]);

        let (status, _, body) =
            send(&instance.base, Method::GET, "/issues", HeaderMap::new()).await;
        assert_eq!(status.as_u16(), 200);
        let answered = frames(&body);
        assert_eq!(
            answered
                .iter()
                .filter(|frame| frame["type"] == "issuesState")
                .count(),
            1,
            "one issuesState: {answered:?}"
        );
        let mut run_ids = BTreeSet::new();
        for frame in &answered {
            match frame["type"].as_str().expect("a frame type") {
                "issuesState" => {}
                "issuesActivity" => {
                    let run_id = frame["runId"].as_str().expect("a run id").to_string();
                    assert!(
                        run_ids.insert(run_id.clone()),
                        "one issuesActivity per runId: {run_id} repeated in {answered:?}"
                    );
                }
                other => panic!("a foreign {other} frame reached /issues: {answered:?}"),
            }
        }
    }

    let (status, _, body) = send_json(&instance.base, Method::PUT, "/resources", json!({})).await;
    assert_eq!(status.as_u16(), 200);
    assert_eq!(
        frame_types(&body),
        vec!["resourcesState"],
        "the mutation's own broadcast answer reaches its request"
    );

    let (status, _, body) = send(
        &instance.base,
        Method::DELETE,
        "/agents/scout/runs",
        HeaderMap::new(),
    )
    .await;
    assert!(status.is_success(), "a Stop answers: {}", status.as_u16());
    let stopped = frame_types(&body);
    assert!(
        stopped.iter().any(|kind| kind == "agentState"),
        "a Stop answers the agent state it changed: {stopped:?}"
    );
    assert!(
        stopped
            .iter()
            .all(|kind| kind == "agentState" || kind == "error"),
        "a Stop carries no other command's frames: {stopped:?}"
    );

    broadcaster.abort();
}

/// Twenty `/version` reads and ten `/project` reads issued while broadcasts
/// run all answer one ETag, and a matching `If-None-Match` answers 304 with an
/// empty body.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn broadcasts_leave_the_validator_stable() {
    let instance = start("stable-validator").await;
    let app = std::sync::Arc::clone(&instance.server.app);
    let broadcaster = tokio::spawn(async move {
        for index in 0..500u64 {
            app.broadcast(json!({"type": "issuesState", "issues": [], "index": index}));
            app.broadcast(json!({"type": "versionState", "running": "foreign"}));
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    });

    let mut version_etag: Option<String> = None;
    for _ in 0..20 {
        let etag = one_stable_validator(&instance.base, "/version", &mut version_etag).await;
        let (status, _, body) = send(
            &instance.base,
            Method::GET,
            "/version",
            headers_with(IF_NONE_MATCH, &etag),
        )
        .await;
        assert_eq!(status.as_u16(), 304, "a matching validator answers 304");
        assert!(body.is_empty());
    }
    let mut project_etag: Option<String> = None;
    for _ in 0..10 {
        let etag = one_stable_validator(&instance.base, "/project", &mut project_etag).await;
        let (status, _, body) = send(
            &instance.base,
            Method::GET,
            "/project",
            headers_with(IF_NONE_MATCH, &etag),
        )
        .await;
        assert_eq!(status.as_u16(), 304, "a matching validator answers 304");
        assert!(body.is_empty());
    }

    broadcaster.abort();
}

/// Reads one path, proves its ETag matches the first one, and answers it.
async fn one_stable_validator(base: &str, path: &str, first: &mut Option<String>) -> String {
    let (status, headers, body) = send(base, Method::GET, path, HeaderMap::new()).await;
    assert_eq!(status.as_u16(), 200);
    let etag = headers
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .expect("an ETag")
        .to_string();
    assert!(!body.is_empty());
    match first {
        Some(expected) => assert_eq!(&etag, expected, "one ETag for {path}"),
        None => *first = Some(etag.clone()),
    }
    etag
}

#[tokio::test]
async fn conditional_get_answers_304() {
    let instance = start("conditional").await;
    let (status, headers, body) =
        send(&instance.base, Method::GET, "/version", HeaderMap::new()).await;
    assert_eq!(status.as_u16(), 200);
    let etag = headers
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .expect("an ETag")
        .to_string();
    assert!(!body.is_empty());
    let (status, headers, body) = send(
        &instance.base,
        Method::GET,
        "/version",
        headers_with(IF_NONE_MATCH, &etag),
    )
    .await;
    assert_eq!(status.as_u16(), 304);
    assert!(body.is_empty());
    assert_eq!(
        headers
            .get(reqwest::header::ETAG)
            .and_then(|value| value.to_str().ok()),
        Some(etag.as_str())
    );
    let (status, headers, body) = send(
        &instance.base,
        Method::GET,
        "/version",
        headers_with(ACCEPT_ENCODING, "gzip"),
    )
    .await;
    assert_eq!(status.as_u16(), 200);
    assert_eq!(
        headers
            .get(reqwest::header::CONTENT_ENCODING)
            .and_then(|value| value.to_str().ok()),
        Some("gzip")
    );
    assert!(!body.is_empty());
    let (status, head_headers, body) =
        send(&instance.base, Method::HEAD, "/version", HeaderMap::new()).await;
    assert_eq!(status.as_u16(), 200);
    assert!(body.is_empty());
    assert_eq!(
        head_headers
            .get(reqwest::header::ETAG)
            .and_then(|value| value.to_str().ok()),
        Some(etag.as_str())
    );
}

#[tokio::test]
async fn rest_refusals_are_problem_json() {
    let instance = start("refusals").await;
    let (status, headers, body) = send(
        &instance.base,
        Method::GET,
        "/records",
        headers_with(HOST, "evil.test"),
    )
    .await;
    assert_problem(status, &headers, &body, 421);
    let (status, headers, body) = send(
        &instance.base,
        Method::GET,
        "/records",
        headers_with(ORIGIN, "http://evil.test"),
    )
    .await;
    assert_problem(status, &headers, &body, 403);
    let (status, headers, body) =
        send(&instance.base, Method::POST, "/records", HeaderMap::new()).await;
    assert_problem(status, &headers, &body, 405);
    assert!(headers
        .get(reqwest::header::ALLOW)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .contains("GET"));
    let (status, headers, body) = send(&instance.base, Method::GET, "/ws", HeaderMap::new()).await;
    assert_problem(status, &headers, &body, 404);
    let (status, headers, body) =
        send(&instance.base, Method::GET, "/feedback", HeaderMap::new()).await;
    assert_problem(status, &headers, &body, 404);
    let (status, headers, body) =
        send(&instance.base, Method::GET, "/reports", HeaderMap::new()).await;
    assert_problem(status, &headers, &body, 405);
    for route in devboard::rest::ROUTES {
        if route.method != Method::GET {
            continue;
        }
        let path = route
            .path
            .split('/')
            .map(|segment| {
                if segment.starts_with('{') {
                    "x"
                } else {
                    segment
                }
            })
            .collect::<Vec<_>>()
            .join("/");
        let (status, headers, body) = send(
            &instance.base,
            Method::GET,
            &path,
            headers_with(HOST, "evil.test"),
        )
        .await;
        assert_problem(status, &headers, &body, 421);
        let (status, headers, body) = send(
            &instance.base,
            Method::GET,
            &path,
            headers_with(ORIGIN, "http://evil.test"),
        )
        .await;
        assert_problem(status, &headers, &body, 403);
    }
}

/// One Issues run record under the instance's state directory: the durable
/// source the run collection and its sockets read.
fn seed_issue_run(instance: &Instance, id: &str, status: &str, worker_pid: u32) -> PathBuf {
    let directory = instance
        .state
        .join("issues")
        .join(devboard::journal::journal_key(&instance.repo))
        .join("runs")
        .join(id);
    std::fs::create_dir_all(&directory).expect("a run directory");
    let record = json!({
        "version": 1,
        "runId": id,
        "repo": "fixture",
        "status": status,
        "workerPid": worker_pid,
        "startedAt": "2026-11-10T00:00:00.000Z",
        "harnessVersion": "1.0.0",
    });
    std::fs::write(directory.join("run.json"), format!("{record}\n")).expect("a run record");
    std::fs::write(
        directory.join("activity.json"),
        format!("{}\n", json!(["one", "two"])),
    )
    .expect("an activity file");
    directory
}

/// The content of one state file, so a test can prove it was not rewritten.
fn bytes(path: &Path) -> (Vec<u8>, std::time::SystemTime) {
    let text = std::fs::read(path).expect("a state file");
    let modified = std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .expect("a modification time");
    (text, modified)
}

#[tokio::test]
async fn the_run_collection_answers_304_without_reading_records() {
    let instance = start("collection-etag").await;
    let first = seed_issue_run(&instance, "first", "succeeded", 999_999);
    let second = seed_issue_run(&instance, "second", "stopped", 999_998);
    // The dashboard's own pollers sample these records first, so the
    // conditional read below is measured against a warm cache.
    tokio::time::sleep(Duration::from_millis(700)).await;

    let (status, headers, _body) =
        send(&instance.base, Method::GET, "/agent-runs", HeaderMap::new()).await;
    assert_eq!(status.as_u16(), 200);
    let etag = headers
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .expect("an ETag")
        .to_string();

    devboard::sampling::reset_reads_under(&instance.state);
    let (status, headers, body) = send(
        &instance.base,
        Method::GET,
        "/agent-runs",
        headers_with(IF_NONE_MATCH, &etag),
    )
    .await;
    assert_eq!(status.as_u16(), 304, "an unchanged collection is a 304");
    assert!(body.is_empty());
    assert_eq!(
        headers
            .get(reqwest::header::ETAG)
            .and_then(|value| value.to_str().ok()),
        Some(etag.as_str())
    );
    assert_eq!(
        devboard::sampling::reads_under(&instance.state),
        0,
        "a 304 reads no run record"
    );

    // One record changes: the answer is a fresh 200, and only that record is
    // read again.
    tokio::time::sleep(Duration::from_millis(10)).await;
    let record = json!({
        "version": 1,
        "runId": "first",
        "repo": "fixture",
        "status": "failed",
        "workerPid": 999_999,
        "startedAt": "2026-11-10T00:00:00.000Z",
        "harnessVersion": "1.0.0",
    });
    std::fs::write(first.join("run.json"), format!("{record}\n")).expect("a changed record");
    let (status, headers, _body) = send(
        &instance.base,
        Method::GET,
        "/agent-runs",
        headers_with(IF_NONE_MATCH, &etag),
    )
    .await;
    assert_eq!(status.as_u16(), 200, "a changed collection is a fresh 200");
    let changed_etag = headers
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .expect("a new ETag")
        .to_string();
    assert_ne!(changed_etag, etag);
    assert_eq!(
        devboard::sampling::reads(&first.join("run.json")),
        1,
        "the changed record is read once"
    );
    assert_eq!(
        devboard::sampling::reads(&second.join("run.json")),
        0,
        "an unchanged record is not read"
    );
}

#[tokio::test]
async fn an_orphaned_issues_run_is_stopped_and_not_live() {
    let instance = start("orphan").await;
    let directory = seed_issue_run(&instance, "orphan", "running", 999_997);
    let run_path = directory.join("run.json");
    let before = bytes(&run_path);

    let (status, _headers, body) =
        send(&instance.base, Method::GET, "/agent-runs", HeaderMap::new()).await;
    assert_eq!(status.as_u16(), 200);
    let value: Value = serde_json::from_slice(&body).expect("JSON");
    let run = value["runs"]
        .as_array()
        .and_then(|runs| runs.iter().find(|run| run["id"] == json!("issues--orphan")))
        .expect("the orphaned record");
    assert_eq!(run["live"], json!(false), "a dead worker holds no socket");
    assert_eq!(
        run["lifecycle"],
        json!("stopped"),
        "and is reported stopped"
    );
    assert_eq!(bytes(&run_path), before, "the record is not rewritten");

    // The run's own read carries the same lifecycle, and the socket closes
    // instead of following a stopped run.
    let (status, _headers, body) = send(
        &instance.base,
        Method::GET,
        "/agent-runs/issues--orphan",
        HeaderMap::new(),
    )
    .await;
    assert_eq!(status.as_u16(), 200);
    let value: Value = serde_json::from_slice(&body).expect("JSON");
    assert_eq!(value["live"], json!(false));
    assert_eq!(value["lifecycle"], json!("stopped"));
}

#[tokio::test]
async fn run_sockets_share_one_sample_per_run() {
    let instance = start("fan-out").await;
    let (a, directory_a) = make_run(&instance, "flow", "share-a", DetachedRunStatus::Running);
    let (b, directory_b) = make_run(&instance, "flow", "share-b", DetachedRunStatus::Running);
    append_detached_run_activity(
        &directory_a,
        &DetachedRunActivity {
            text: "A line".to_string(),
            append: false,
        },
    );
    append_detached_run_activity(
        &directory_b,
        &DetachedRunActivity {
            text: "B line".to_string(),
            append: false,
        },
    );
    // Two sockets for A, one for B: the second A socket must add no read.
    let mut first_a = socket(instance.port, &a, None).await;
    let mut second_a = socket(instance.port, &a, None).await;
    let mut socket_b = socket(instance.port, &b, None).await;
    let warm_a = collect(&mut first_a, Duration::from_millis(200)).await;
    let warm_b = collect(&mut socket_b, Duration::from_millis(200)).await;
    assert!(!warm_a.is_empty());
    assert!(!warm_b.is_empty());

    devboard::sampling::reset_reads_under(&directory_a);
    devboard::sampling::reset_reads_under(&directory_b);
    let more_a = collect(&mut first_a, Duration::from_millis(1_200)).await;
    let more_a2 = collect(&mut second_a, Duration::from_millis(50)).await;
    let more_b = collect(&mut socket_b, Duration::from_millis(1_200)).await;
    let reads_a = devboard::sampling::reads(&directory_a.join("state.json"));
    let reads_b = devboard::sampling::reads(&directory_b.join("state.json"));
    assert!(
        reads_a <= 4,
        "two sockets for A sample it at most once per interval: {reads_a}"
    );
    assert_eq!(
        reads_a, reads_b,
        "the second socket for A adds no read: {reads_a} vs {reads_b}"
    );
    for frame in more_a.iter().chain(more_a2.iter()) {
        assert_eq!(frame["run"], a, "A's sockets carry only A's frames");
    }
    for frame in &more_b {
        assert_eq!(frame["run"], b, "B's socket carries only B's frames");
    }
    assert!(!more_b.iter().any(|frame| frame["text"] == json!("A line")));

    // A cursor that is caught up answers no frames and keeps the socket open.
    let caught_up = warm_b
        .iter()
        .filter_map(|frame| frame["cursor"].as_u64())
        .max()
        .expect("a cursor");
    let mut resumed = socket(instance.port, &b, Some(caught_up)).await;
    let empty = collect(&mut resumed, Duration::from_millis(300)).await;
    assert!(
        empty.is_empty(),
        "a caught-up cursor answers no frames: {empty:?}"
    );
}

#[tokio::test]
async fn an_appended_activity_reaches_a_socket_within_500_ms() {
    let instance = start("freshness").await;
    let (id, directory) = make_run(&instance, "flow", "fresh", DetachedRunStatus::Running);
    let mut socket = socket(instance.port, &id, None).await;
    let warm = collect(&mut socket, Duration::from_millis(300)).await;
    assert!(!warm.is_empty());

    let started = tokio::time::Instant::now();
    append_detached_run_activity(
        &directory,
        &DetachedRunActivity {
            text: "an appended line".to_string(),
            append: false,
        },
    );
    let frames = tokio::time::timeout(Duration::from_millis(500), async {
        loop {
            match socket.next().await {
                Some(Ok(Message::Text(text))) => {
                    if let Ok(frame) = serde_json::from_str::<Value>(&text) {
                        if frame["type"] == "activity" && frame["text"] == json!("an appended line")
                        {
                            return frame;
                        }
                    }
                }
                Some(Ok(_)) => continue,
                _ => panic!("the socket closed before the appended line"),
            }
        }
    })
    .await
    .expect("the appended line arrives within 500 ms");
    assert_eq!(frames["run"], id);
    assert!(started.elapsed() < Duration::from_millis(500));
}
