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
    tokio::spawn(async move {
        let _ = devboard::http::serve_on(listener, server).await;
    });
    Instance {
        base: format!("http://127.0.0.1:{port}"),
        port,
        state,
        repo,
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
