//! The mutating endpoints: report filing against a stub Gitea, draft writing,
//! and the idempotent replay of one keyed request.

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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

type StubState = (
    Arc<Mutex<Vec<Value>>>,
    Arc<AtomicUsize>,
    Option<StatusCode>,
    u64,
);

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
    start_with(label, None).await
}

/// One fixture whose stub Gitea answers `500` instead of filing an issue.
async fn start_failing(label: &str) -> Fixture {
    start_with(label, Some(StatusCode::INTERNAL_SERVER_ERROR)).await
}

/// One fixture whose stub Gitea rejects the dashboard's credential.
async fn start_rejecting(label: &str) -> Fixture {
    start_with(label, Some(StatusCode::UNAUTHORIZED)).await
}

async fn start_with(label: &str, failure: Option<StatusCode>) -> Fixture {
    start_against(label, failure, None, 5000, "true", 0).await
}

/// One fixture whose stub Gitea spends `delay_ms` before filing an issue, so
/// the delivery outlasts the operator action's own budget.
async fn start_slow(label: &str, delay_ms: u64) -> Fixture {
    start_against(label, None, None, 5000, "true", delay_ms).await
}

/// One fixture whose dashboard sends reports to `forge` instead of the stub,
/// with `timeout_ms` as the delivery deadline, `agent_command` as the
/// configured agent command, and `delay_ms` as the stub forge's own latency.
async fn start_against(
    label: &str,
    failure: Option<StatusCode>,
    forge: Option<&str>,
    timeout_ms: u64,
    agent_command: &str,
    delay_ms: u64,
) -> Fixture {
    let root = fixture_root(label);
    let repo = root.join("repo");
    let calls: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let count = Arc::new(AtomicUsize::new(0));
    let stub_state = (calls.clone(), count.clone(), failure, delay_ms);
    let stub_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("a stub listener");
    let stub_port = stub_listener.local_addr().expect("an address").port();
    let stub = tokio::spawn(async move {
        let app = axum::Router::new()
            .route(
                "/api/v1/repos/dsdenes/devboard/issues",
                post(
                    |State((calls, count, failure, delay_ms)): State<StubState>,
                     Json(body): Json<Value>| async move {
                        count.fetch_add(1, Ordering::SeqCst);
                        calls.lock().expect("calls").push(body.clone());
                        if delay_ms > 0 {
                            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                        }
                        if let Some(status) = failure {
                            let message = if status == StatusCode::UNAUTHORIZED {
                                "invalid username, password or token"
                            } else {
                                "gitea is offline"
                            };
                            return (status, message).into_response();
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
        adrs_dir: repo.join("adrs"),
        repo_dir: repo.clone(),
        goal_file: repo.join("GOAL.md"),
        static_dir: Some(root.join("static")),
        agent_command: agent_command.to_string(),
        state_dir: root.join("state"),
        allowed_hosts: Vec::new(),
        feedback: Some(FeedbackConfig {
            base_url: forge
                .map(str::to_string)
                .unwrap_or_else(|| format!("http://127.0.0.1:{stub_port}")),
            repo: "dsdenes/devboard".to_string(),
            token: None,
            timeout_ms,
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

/// The `Goal` click answers from the request's own work. A configured agent
/// that starts slowly must never delay the draft: the request writes it under
/// the deterministic name and spawns no peer.
#[tokio::test]
async fn a_goal_proposal_never_waits_for_a_naming_agent() {
    let scratch = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("proposal-agent-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&scratch);
    std::fs::create_dir_all(&scratch).expect("a scratch root");
    let marker = scratch.join("agent-started");
    let script = scratch.join("slow-agent.sh");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\n\
             printf started > '{}'\n\
             sleep 3\n",
            marker.display()
        ),
    )
    .expect("a slow agent");
    let mut permissions = std::fs::metadata(&script)
        .expect("the slow agent")
        .permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&script, permissions).expect("an executable slow agent");

    let fixture = start_against(
        "proposal-agent",
        None,
        None,
        5000,
        script.to_str().expect("a slow agent path"),
        0,
    )
    .await;
    let started = Instant::now();
    let response = client()
        .post(format!("{}/goal-proposals", fixture.base))
        .headers(bearer())
        .json(&json!({"report": "Make the header calm"}))
        .send()
        .await
        .expect("an answer");
    let elapsed = started.elapsed();
    assert_eq!(response.status(), 201);
    assert!(
        elapsed < Duration::from_millis(1000),
        "the proposal answered in {elapsed:?}, over the 1000 ms budget"
    );
    assert!(
        !marker.exists(),
        "a proposal request spawned the configured agent"
    );
    assert!(
        fixture
            .repo
            .join(".devboard/goal-proposals/make-the-header-calm.md")
            .is_file(),
        "the draft carries the deterministic name"
    );
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
        .post(format!("{}/reports", fixture.base))
        .headers(bearer())
        .json(&json!({"report": "Fix the header", "route": "/"}))
        .send()
        .await
        .expect("an answer");
    assert_eq!(
        response.status(),
        202,
        "the endpoint answers the record it owns, not the forge write"
    );
    let location = response
        .headers()
        .get("location")
        .and_then(|value| value.to_str().ok())
        .expect("a Location")
        .to_string();
    let accepted: Value = response.json().await.expect("JSON");
    assert_eq!(accepted["status"], "FILING");
    assert_eq!(accepted["title"], "[ui] Fix the header");
    assert_eq!(
        accepted["links"]["report"]["href"].as_str(),
        Some(location.as_str()),
        "the body links the resource its Location names"
    );

    let record = settled_report(&location).await;
    assert_eq!(record["status"], "FILED");
    assert_eq!(
        record["links"]["issue"]["href"].as_str(),
        Some("https://gitea.test/dsdenes/devboard/issues/1")
    );
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

/// Reads one accepted report until its delivery settles.
async fn settled_report(location: &str) -> Value {
    for _ in 0..500 {
        let response = client().get(location).send().await.expect("an answer");
        assert_eq!(response.status(), 200, "{location}");
        let record: Value = response.json().await.expect("JSON");
        if record["status"] != "FILING" {
            return record;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the report at {location} never settled");
}

/// The regression this operator report describes: a forge that spends seconds
/// on one issue creation must not hold the operator's action open, so the
/// endpoint answers its own record inside the action's own budget and the
/// delivery settles afterwards.
#[tokio::test]
async fn an_accepted_report_answers_before_the_forge_finishes_filing_it() {
    let fixture = start_slow("feedback-slow-forge", 2_000).await;
    let started = Instant::now();
    let response = client()
        .post(format!("{}/reports", fixture.base))
        .headers(bearer())
        .json(&json!({"report": "Fix the header"}))
        .send()
        .await
        .expect("an answer");
    let elapsed = started.elapsed();
    assert_eq!(response.status(), 202);
    assert!(
        elapsed < Duration::from_millis(1_000),
        "the action answered in {elapsed:?}, inside its own 1000 ms budget"
    );
    let location = response
        .headers()
        .get("location")
        .and_then(|value| value.to_str().ok())
        .expect("a Location")
        .to_string();
    let record = settled_report(&location).await;
    assert_eq!(record["status"], "FILED");
    assert_eq!(
        record["links"]["issue"]["href"].as_str(),
        Some("https://gitea.test/dsdenes/devboard/issues/1")
    );
    assert_eq!(fixture.count.load(Ordering::SeqCst), 1);
    fixture.handle.abort();
    fixture.stub.abort();
}

#[tokio::test]
async fn a_failed_delivery_keeps_its_detail_and_journals_the_diagnostic() {
    let fixture = start_failing("feedback-failure").await;
    let response = client()
        .post(format!("{}/reports", fixture.base))
        .headers(bearer())
        .json(&json!({"report": "Fix the header", "route": "/"}))
        .send()
        .await
        .expect("an answer");
    assert_eq!(response.status(), 202);
    let location = response
        .headers()
        .get("location")
        .and_then(|value| value.to_str().ok())
        .expect("a Location")
        .to_string();
    let record = settled_report(&location).await;
    assert_eq!(record["status"], "FAILED");
    assert_eq!(record["detail"], "The issue could not be filed.");
    assert_eq!(fixture.count.load(Ordering::SeqCst), 1);

    let journal = devboard::journal::journal_file(&fixture.root.join("state"), &fixture.repo);
    let text = std::fs::read_to_string(&journal).expect("the journal");
    assert!(
        text.contains("\"kind\":\"server-error\""),
        "the failed delivery is journaled: {text}"
    );
    assert!(
        text.contains("POST /reports: Issue creation failed: POST /repos/dsdenes/devboard/issues failed (HTTP 500): gitea is offline"),
        "the journal names the delivery's own diagnostic: {text}"
    );
    assert!(
        !text.contains("POST /reports: The issue could not be filed."),
        "the journal never repeats the client-facing detail: {text}"
    );
    fixture.handle.abort();
    fixture.stub.abort();
}

#[tokio::test]
async fn a_rejected_credential_is_a_configuration_failure_not_a_server_error() {
    let fixture = start_rejecting("feedback-rejected").await;
    let response = client()
        .post(format!("{}/reports", fixture.base))
        .headers(bearer())
        .json(&json!({"report": "Fix the header"}))
        .send()
        .await
        .expect("an answer");
    assert_eq!(response.status(), 202);
    let location = response
        .headers()
        .get("location")
        .and_then(|value| value.to_str().ok())
        .expect("a Location")
        .to_string();
    let record = settled_report(&location).await;
    assert_eq!(record["status"], "FAILED");
    assert_eq!(
        record["detail"],
        "Harness reporting is unavailable: the forge rejected the reporting credential. Refresh \
         GITEA_TOKEN (or DEVBOARD_GITEA_TOKEN) and restart the dashboard."
    );
    assert_eq!(fixture.count.load(Ordering::SeqCst), 1);

    let journal = devboard::journal::journal_file(&fixture.root.join("state"), &fixture.repo);
    let text = std::fs::read_to_string(&journal).expect("the journal");
    assert!(
        text.contains("\"kind\":\"activity\""),
        "a rejected credential is a configuration failure: {text}"
    );
    assert!(
        text.contains(
            "feedback delivery rejected: POST /reports: Issue creation failed: \
             POST /repos/dsdenes/devboard/issues failed (HTTP 401): \
             invalid username, password or token"
        ),
        "the journal names the forge's own rejection: {text}"
    );
    assert!(
        !text.contains("\"kind\":\"server-error\""),
        "the endpoint served, so its rejection is no server error: {text}"
    );
    fixture.handle.abort();
    fixture.stub.abort();
}

#[tokio::test]
async fn a_forge_that_answers_nothing_delays_the_report_without_a_server_error() {
    let forge = format!("http://127.0.0.1:{}", closed_port().await);
    let fixture = start_against("feedback-unreachable", None, Some(&forge), 500, "true", 0).await;
    let response = client()
        .post(format!("{}/reports", fixture.base))
        .headers(bearer())
        .json(&json!({"report": "Fix the header"}))
        .send()
        .await
        .expect("an answer");
    assert_eq!(response.status(), 202);
    let location = response
        .headers()
        .get("location")
        .and_then(|value| value.to_str().ok())
        .expect("a Location")
        .to_string();
    let record = settled_report(&location).await;
    assert_eq!(record["status"], "FAILED");
    assert_eq!(record["detail"], "The issue could not be filed.");

    let journal = devboard::journal::journal_file(&fixture.root.join("state"), &fixture.repo);
    let text = std::fs::read_to_string(&journal).expect("the journal");
    assert!(
        text.contains("\"kind\":\"activity\""),
        "a forge that answered nothing is a delayed delivery: {text}"
    );
    assert!(
        text.contains(
            "feedback delivery delayed: POST /reports: Issue creation failed: error sending request for url"
        ),
        "the journal names the transport failure: {text}"
    );
    assert!(
        text.to_ascii_lowercase().contains("connection refused"),
        "the journal names the socket answer below the request line: {text}"
    );
    assert!(
        !text.contains("\"kind\":\"server-error\""),
        "the endpoint served, so its failure is no server error: {text}"
    );
    fixture.handle.abort();
    fixture.stub.abort();
}

#[tokio::test]
async fn a_forge_that_never_answers_times_out_as_a_delayed_delivery() {
    let silent = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("a silent listener");
    let forge = format!(
        "http://127.0.0.1:{}",
        silent.local_addr().expect("an address").port()
    );
    let fixture = start_against("feedback-silent", None, Some(&forge), 250, "true", 0).await;
    let response = client()
        .post(format!("{}/reports", fixture.base))
        .headers(bearer())
        .json(&json!({"report": "Fix the header"}))
        .send()
        .await
        .expect("an answer");
    assert_eq!(response.status(), 202);
    let location = response
        .headers()
        .get("location")
        .and_then(|value| value.to_str().ok())
        .expect("a Location")
        .to_string();
    let record = settled_report(&location).await;
    assert_eq!(record["status"], "FAILED");
    assert_eq!(record["detail"], "Issue creation timed out after 250 ms.");

    let journal = devboard::journal::journal_file(&fixture.root.join("state"), &fixture.repo);
    let text = std::fs::read_to_string(&journal).expect("the journal");
    assert!(
        text.contains("\"kind\":\"activity\""),
        "a missed deadline is a delayed delivery: {text}"
    );
    assert!(
        text.contains("Issue creation timed out after 250 ms."),
        "the journal names the deadline: {text}"
    );
    assert!(
        !text.contains("\"kind\":\"server-error\""),
        "the endpoint served, so its failure is no server error: {text}"
    );
    fixture.handle.abort();
    fixture.stub.abort();
    drop(silent);
}

/// A loopback port whose listener was closed again, so nothing accepts.
async fn closed_port() -> u16 {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("a listener");
    let port = listener.local_addr().expect("an address").port();
    drop(listener);
    port
}

/// The report every delivery test files, and the target that answers its POST.
fn one_report(
    port: u16,
) -> (
    devboard::feedback::FeedbackSubmission,
    devboard::gitea::GiteaTarget,
) {
    let submission =
        devboard::feedback::parse_feedback_submission(&json!({"report": "Fix the header"}))
            .expect("a submission");
    let target = devboard::gitea::GiteaTarget {
        base_url: format!("http://127.0.0.1:{port}"),
        project: "dsdenes/devboard".to_string(),
        token: None,
    };
    (submission, target)
}

fn recording_sleep() -> (devboard::forge::Sleep, Arc<Mutex<Vec<u64>>>) {
    let delays: Arc<Mutex<Vec<u64>>> = Arc::new(Mutex::new(Vec::new()));
    let seen = delays.clone();
    let sleep: devboard::forge::Sleep = Arc::new(move |millis| {
        seen.lock().expect("delays").push(millis);
        Box::pin(async {})
    });
    (sleep, delays)
}

#[tokio::test]
async fn a_refused_connection_spends_the_retry_schedule_before_the_delivery_fails() {
    let (submission, target) = one_report(closed_port().await);
    let (sleep, delays) = recording_sleep();
    let error = devboard::feedback::file_feedback_issue(&submission, &target, None, 60_000, &sleep)
        .await
        .expect_err("the forge never answered");
    assert_eq!(error.status, 502);
    assert!(
        error.transient,
        "an unreachable forge is a delayed delivery"
    );
    assert_eq!(error.message, "The issue could not be filed.");
    assert_eq!(
        *delays.lock().expect("delays"),
        vec![1_000, 2_000, 4_000, 8_000]
    );
    let diagnostic = error.diagnostic.to_ascii_lowercase();
    assert!(diagnostic.contains("connection refused"), "{diagnostic}");
}

#[tokio::test]
async fn a_refused_connection_that_opens_on_the_retry_files_the_report() {
    let port = closed_port().await;
    let delays: Arc<Mutex<Vec<u64>>> = Arc::new(Mutex::new(Vec::new()));
    let seen = delays.clone();
    let sleep: devboard::forge::Sleep = Arc::new(move |millis| {
        seen.lock().expect("delays").push(millis);
        Box::pin(async move {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
                .await
                .expect("the retry forge");
            tokio::spawn(async move {
                let app = axum::Router::new().route(
                    "/api/v1/repos/dsdenes/devboard/issues",
                    post(|Json(body): Json<Value>| async move {
                        Json(json!({
                            "number": 1,
                            "title": body.get("title").cloned().unwrap_or(Value::Null),
                            "html_url": "https://gitea.test/dsdenes/devboard/issues/1",
                        }))
                    }),
                );
                let _ = axum::serve(listener, app).await;
            });
        })
    });
    let (submission, target) = one_report(port);
    let filed = devboard::feedback::file_feedback_issue(&submission, &target, None, 60_000, &sleep)
        .await
        .expect("the retried delivery");
    assert_eq!(
        filed.pointer("/links/issue/href").and_then(Value::as_str),
        Some("https://gitea.test/dsdenes/devboard/issues/1")
    );
    assert_eq!(*delays.lock().expect("delays"), vec![1_000]);
}

#[tokio::test]
async fn a_repeated_idempotency_key_files_one_issue() {
    let fixture = start("idempotency").await;
    let mut headers = bearer();
    headers.insert("idempotency-key", HeaderValue::from_static("retry-1"));
    let first = client()
        .post(format!("{}/reports", fixture.base))
        .headers(headers.clone())
        .json(&json!({"report": "One report"}))
        .send()
        .await
        .expect("an answer");
    assert_eq!(first.status(), 202);
    let location = first
        .headers()
        .get("location")
        .and_then(|value| value.to_str().ok())
        .expect("a Location")
        .to_string();
    let filed = settled_report(&location).await;
    assert_eq!(filed["status"], "FILED");
    let second = client()
        .post(format!("{}/reports", fixture.base))
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
    assert_eq!(
        second.status(),
        200,
        "a filed report replays as its settled record, never a second creation"
    );
    let replay: Value = second.json().await.expect("JSON");
    assert_eq!(replay["id"], filed["id"]);
    assert_eq!(
        replay["links"]["issue"]["href"],
        "https://gitea.test/dsdenes/devboard/issues/1"
    );
    assert_eq!(fixture.count.load(Ordering::SeqCst), 1);
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
        .post(format!("{}/reports", fixture.base))
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
    let (status, answer) = chunked_post(&fixture, "/reports", &report_body(64_002)).await;
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
        .post(format!("{}/reports", fixture.base))
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
