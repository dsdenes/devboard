//! The mutating endpoints: report filing against a stub Gitea, draft writing,
//! and the idempotent replay of one keyed request.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::post;
use axum::Json;
use devboard::config::{Config, FeedbackConfig};
use devboard::http::Server;
use devboard::journal::Journal;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use serde_json::{json, Value};

type StubState = (Arc<Mutex<Vec<Value>>>, Arc<AtomicUsize>, bool);

const TOKEN: &str = "contract-token";

struct Fixture {
    base: String,
    repo: PathBuf,
    root: PathBuf,
    calls: Arc<Mutex<Vec<Value>>>,
    count: Arc<AtomicUsize>,
    handle: tokio::task::JoinHandle<()>,
    stub: tokio::task::JoinHandle<()>,
}

fn fixture_root(label: &str) -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("endpoints-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("repo/adrs")).expect("a fixture root");
    std::fs::create_dir_all(root.join("state")).expect("a fixture state");
    std::fs::create_dir_all(root.join("static")).expect("a fixture static root");
    std::fs::write(root.join("static/index.html"), "<!doctype html>\n").expect("a document");
    root
}

async fn start(label: &str) -> Fixture {
    start_with(label, false).await
}

/// One fixture whose stub Gitea answers `500` instead of filing an issue.
async fn start_failing(label: &str) -> Fixture {
    start_with(label, true).await
}

async fn start_with(label: &str, failing: bool) -> Fixture {
    let root = fixture_root(label);
    let repo = root.join("repo");
    let calls: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let count = Arc::new(AtomicUsize::new(0));
    let stub_state = (calls.clone(), count.clone(), failing);
    let stub_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("a stub listener");
    let stub_port = stub_listener.local_addr().expect("an address").port();
    let stub = tokio::spawn(async move {
        let app = axum::Router::new()
            .route(
                "/api/v1/repos/dsdenes/devboard/issues",
                post(
                    |State((calls, count, failing)): State<StubState>,
                     Json(body): Json<Value>| async move {
                        count.fetch_add(1, Ordering::SeqCst);
                        calls.lock().expect("calls").push(body.clone());
                        if failing {
                            return (StatusCode::INTERNAL_SERVER_ERROR, "gitea is offline")
                                .into_response();
                        }
                        let number = count.load(Ordering::SeqCst);
                        Json(json!({
                            "number": number,
                            "title": body.get("title").cloned().unwrap_or(Value::Null),
                            "html_url": format!("https://gitea.test/dsdenes/devboard/issues/{number}"),
                        }))
                        .into_response()
                    },
                ),
            )
            .with_state(stub_state);
        let _ = axum::serve(stub_listener, app).await;
    });
    let config = Config {
        hostname: "127.0.0.1".to_string(),
        port: 0,
        addr_dir: repo.join("adrs"),
        repo_dir: repo.clone(),
        goal_file: repo.join("GOAL.md"),
        static_dir: Some(root.join("static")),
        agent_command: "true".to_string(),
        state_dir: root.join("state"),
        allowed_hosts: Vec::new(),
        token: TOKEN.to_string(),
        bootstrap: "test-bootstrap".to_string(),
        feedback: Some(FeedbackConfig {
            base_url: format!("http://127.0.0.1:{stub_port}"),
            repo: "dsdenes/devboard".to_string(),
            token: None,
            timeout_ms: 5000,
        }),
    };
    let listener = devboard::http::bind("127.0.0.1", 0)
        .await
        .expect("a listener");
    let port = listener.local_addr().expect("an address").port();
    let mut config = config;
    config.port = port;
    let journal = Journal::open(&config.state_dir, &config.repo_dir, port);
    let server = Server::new(config, journal);
    let handle = tokio::spawn(async move {
        let _ = devboard::http::serve_on(listener, server).await;
    });
    Fixture {
        base: format!("http://127.0.0.1:{port}"),
        repo,
        root,
        calls,
        count,
        handle,
        stub,
    }
}

fn bearer() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {TOKEN}")).expect("a token"),
    );
    headers
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_gzip()
        .build()
        .expect("a client")
}

#[tokio::test]
async fn a_goal_proposal_writes_one_draft_and_answers_201() {
    let fixture = start("proposal").await;
    let response = client()
        .post(format!("{}/goal-proposals", fixture.base))
        .headers(bearer())
        .json(&json!({"report": "Make the header calm"}))
        .send()
        .await
        .expect("an answer");
    assert_eq!(response.status(), 201);
    let location = response
        .headers()
        .get("location")
        .and_then(|value| value.to_str().ok())
        .expect("a Location")
        .to_string();
    let body: Value = response.json().await.expect("JSON");
    assert_eq!(
        body.pointer("/links/draft/href").and_then(Value::as_str),
        Some(location.as_str())
    );
    let draft = fixture
        .repo
        .join(".devboard/goal-proposals/make-the-header-calm.md");
    assert!(draft.is_file(), "the draft exists at {}", draft.display());
    let text = std::fs::read_to_string(&draft).expect("the draft text");
    assert!(text.starts_with("# Proposed goal: Make the header calm\n\n"));
    assert!(text.contains("## Captured UI context"));
    assert!(
        location.starts_with("http://") || location.starts_with("https://"),
        "the draft link dereferences on the host that answered: {location}"
    );

    // The linked route serves the exact draft bytes, with no-store.
    let response = client()
        .get(&location)
        .headers(bearer())
        .send()
        .await
        .expect("the draft answer");
    assert_eq!(response.status(), 200);
    assert_eq!(
        response
            .headers()
            .get("cache-control")
            .and_then(|value| value.to_str().ok()),
        Some("no-store")
    );
    let served = response.text().await.expect("the draft bytes");
    assert_eq!(served, text);

    let response = client()
        .head(&location)
        .headers(bearer())
        .send()
        .await
        .expect("the HEAD answer");
    assert_eq!(response.status(), 200);
    let body = response.bytes().await.expect("a body");
    assert!(body.is_empty(), "HEAD carries no draft bytes");

    let response = client()
        .put(&location)
        .headers(bearer())
        .send()
        .await
        .expect("the method answer");
    assert_eq!(response.status(), 405);
    assert_eq!(
        response
            .headers()
            .get("allow")
            .and_then(|value| value.to_str().ok()),
        Some("GET, HEAD")
    );

    let response = client()
        .get(format!("{}/goal-proposals/missing.md", fixture.base))
        .headers(bearer())
        .send()
        .await
        .expect("the absent answer");
    assert_eq!(response.status(), 404);

    // A second submission with the same text takes the next free name.
    let response = client()
        .post(format!("{}/goal-proposals", fixture.base))
        .headers(bearer())
        .json(&json!({"report": "Make the header calm"}))
        .send()
        .await
        .expect("an answer");
    assert_eq!(response.status(), 201);
    assert!(fixture
        .repo
        .join(".devboard/goal-proposals/make-the-header-calm-2.md")
        .is_file());
    fixture.handle.abort();
    fixture.stub.abort();
}

#[tokio::test]
async fn a_goal_proposal_refuses_an_unknown_field_and_invalid_json() {
    let fixture = start("proposal-refusals").await;
    let response = client()
        .post(format!("{}/goal-proposals", fixture.base))
        .headers(bearer())
        .body("not json")
        .send()
        .await
        .expect("an answer");
    assert_eq!(response.status(), 400);
    let body: Value = response.json().await.expect("JSON");
    assert_eq!(body["detail"], "The report is not valid JSON.");

    let response = client()
        .post(format!("{}/goal-proposals", fixture.base))
        .headers(bearer())
        .json(&json!({"report": "x", "nope": true}))
        .send()
        .await
        .expect("an answer");
    assert_eq!(response.status(), 400);
    let body: Value = response.json().await.expect("JSON");
    assert_eq!(body["detail"], "unknown field: nope.");
    fixture.handle.abort();
    fixture.stub.abort();
}

#[tokio::test]
async fn a_report_files_one_issue_through_the_configured_gitea() {
    let fixture = start("feedback").await;
    let response = client()
        .post(format!("{}/feedback", fixture.base))
        .headers(bearer())
        .json(&json!({"report": "Fix the header", "route": "/"}))
        .send()
        .await
        .expect("an answer");
    assert_eq!(response.status(), 201);
    let body: Value = response.json().await.expect("JSON");
    assert!(body
        .pointer("/links/issue/href")
        .and_then(Value::as_str)
        .is_some());
    assert_eq!(fixture.count.load(Ordering::SeqCst), 1);
    let calls = fixture.calls.lock().expect("calls").clone();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["title"], "[ui] Fix the header");
    assert!(calls[0]["body"]
        .as_str()
        .expect("a body")
        .contains("## Operator report"));
    fixture.handle.abort();
    fixture.stub.abort();
}

#[tokio::test]
async fn a_failed_delivery_keeps_its_detail_and_journals_the_diagnostic() {
    let fixture = start_failing("feedback-failure").await;
    let response = client()
        .post(format!("{}/feedback", fixture.base))
        .headers(bearer())
        .json(&json!({"report": "Fix the header", "route": "/"}))
        .send()
        .await
        .expect("an answer");
    assert_eq!(response.status(), 502);
    let body: Value = response.json().await.expect("JSON");
    assert_eq!(body["detail"], "The issue could not be filed.");
    assert_eq!(fixture.count.load(Ordering::SeqCst), 1);

    let journal = devboard::journal::journal_file(&fixture.root.join("state"), &fixture.repo);
    let text = std::fs::read_to_string(&journal).expect("the journal");
    assert!(
        text.contains("\"kind\":\"server-error\""),
        "the failed delivery is journaled: {text}"
    );
    assert!(
        text.contains("POST /feedback: Issue creation failed: POST /repos/dsdenes/devboard/issues failed (HTTP 500): gitea is offline"),
        "the journal names the delivery's own diagnostic: {text}"
    );
    assert!(
        !text.contains("POST /feedback: The issue could not be filed."),
        "the journal never repeats the client-facing detail: {text}"
    );
    fixture.handle.abort();
    fixture.stub.abort();
}

#[tokio::test]
async fn a_repeated_idempotency_key_files_one_issue() {
    let fixture = start("idempotency").await;
    let mut headers = bearer();
    headers.insert("idempotency-key", HeaderValue::from_static("retry-1"));
    let first = client()
        .post(format!("{}/feedback", fixture.base))
        .headers(headers.clone())
        .json(&json!({"report": "One report"}))
        .send()
        .await
        .expect("an answer");
    let second = client()
        .post(format!("{}/feedback", fixture.base))
        .headers(headers)
        .json(&json!({
            "report": "One report\n\nRaised at: 2026-11-04T20:42:38.858Z",
            "route": "/",
            "url": "http://127.0.0.1:8081/",
            "selector": ".notification",
            "dom_excerpt": "<div class=\"notification\"></div>",
            "visible_text": "error · Flow",
            "viewport": "1365x768 @1.25x",
            "captured_at": "2026-11-04T20:42:39.000Z"
        }))
        .send()
        .await
        .expect("an answer");
    assert_eq!(first.status(), 201);
    assert_eq!(second.status(), 201);
    assert_eq!(fixture.count.load(Ordering::SeqCst), 1);
    let first: Value = first.json().await.expect("JSON");
    let second: Value = second.json().await.expect("JSON");
    assert_eq!(first, second);
    fixture.handle.abort();
    fixture.stub.abort();
}

/// One report body of exactly `len` bytes that is still valid JSON.
fn report_body(len: usize) -> String {
    let prefix = "{\"report\":\"";
    let suffix = "\"}";
    let filler = len - prefix.len() - suffix.len();
    format!("{prefix}{}{suffix}", "x".repeat(filler))
}

/// One raw chunked POST, so the request carries no `Content-Length`.
async fn chunked_post(fixture: &Fixture, path: &str, body: &str) -> (u16, String) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let port = fixture
        .base
        .rsplit(':')
        .next()
        .and_then(|value| value.parse::<u16>().ok())
        .expect("a port");
    let mut request = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {TOKEN}\r\n\
         Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n\
         Connection: close\r\n\r\n"
    )
    .into_bytes();
    for chunk in body.as_bytes().chunks(4_096) {
        request.extend_from_slice(format!("{:x}\r\n", chunk.len()).as_bytes());
        request.extend_from_slice(chunk);
        request.extend_from_slice(b"\r\n");
    }
    request.extend_from_slice(b"0\r\n\r\n");
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("a connection");
    // The server answers and closes as soon as the over-bound body is read, so
    // a write error carries no information; the headers below are the evidence.
    let _ = stream.write_all(&request).await;
    let mut answer = Vec::new();
    let mut buf = [0u8; 4096];
    while !answer.windows(4).any(|window| window == b"\r\n\r\n") {
        match stream.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(read) => answer.extend_from_slice(&buf[..read]),
        }
    }
    let text = String::from_utf8_lossy(&answer).to_string();
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or_else(|| panic!("no status line in {text:?}"));
    (status, text)
}

/// One response header from the raw answer above, lower-cased by name.
fn header(answer: &str, wanted: &str) -> String {
    answer
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.trim()
                .eq_ignore_ascii_case(wanted)
                .then(|| value.trim().to_string())
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn an_oversized_report_is_refused_before_parsing() {
    let fixture = start("oversized").await;
    let response = client()
        .post(format!("{}/feedback", fixture.base))
        .headers(bearer())
        .body("x".repeat(64_001))
        .send()
        .await
        .expect("an answer");
    assert_eq!(response.status(), 413);
    assert_eq!(
        response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok()),
        Some("application/problem+json")
    );
    assert!(!fixture.root.join("repo").join(".devboard").exists());
    fixture.handle.abort();
    fixture.stub.abort();
}

#[tokio::test]
async fn a_chunked_feedback_body_over_the_bound_answers_413() {
    let fixture = start("chunked-oversized").await;
    let (status, answer) = chunked_post(&fixture, "/feedback", &report_body(64_002)).await;
    assert_eq!(status, 413, "{answer}");
    assert_eq!(header(&answer, "content-type"), "application/problem+json");
    assert_eq!(
        fixture.count.load(Ordering::SeqCst),
        0,
        "an oversized report is never filed"
    );
    fixture.handle.abort();
    fixture.stub.abort();
}

#[tokio::test]
async fn a_chunked_goal_proposal_body_over_the_bound_answers_413() {
    let fixture = start("chunked-proposal").await;
    let (status, answer) = chunked_post(&fixture, "/goal-proposals", &report_body(64_002)).await;
    assert_eq!(status, 413, "{answer}");
    assert_eq!(header(&answer, "content-type"), "application/problem+json");
    assert!(
        !fixture.repo.join(".devboard/goal-proposals").exists(),
        "an oversized proposal writes no draft"
    );
    fixture.handle.abort();
    fixture.stub.abort();
}

#[tokio::test]
async fn a_report_that_is_not_utf8_answers_400() {
    let fixture = start("not-utf8").await;
    let response = client()
        .post(format!("{}/feedback", fixture.base))
        .headers(bearer())
        .body(vec![0x7b, 0xff, 0xfe, 0x7d])
        .send()
        .await
        .expect("an answer");
    assert_eq!(response.status(), 400);
    let body: Value = response.json().await.expect("JSON");
    assert_eq!(body["detail"], "The report could not be read.");
    fixture.handle.abort();
    fixture.stub.abort();
}

#[tokio::test]
async fn an_empty_goal_proposal_answers_400() {
    let fixture = start("empty-proposal").await;
    let response = client()
        .post(format!("{}/goal-proposals", fixture.base))
        .headers(bearer())
        .body(Vec::new())
        .send()
        .await
        .expect("an answer");
    assert_eq!(response.status(), 400);
    assert_eq!(
        response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok()),
        Some("application/problem+json")
    );
    fixture.handle.abort();
    fixture.stub.abort();
}
