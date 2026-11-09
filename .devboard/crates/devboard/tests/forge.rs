//! The forge contract: origin parsing, Gitea REST paths and headers, auth,
//! retry delays, tracker polling, release reads, and local discovery.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::State;
use devboard::forge::*;
use devboard::workers::scout::{GiteaScoutForge, ScoutForge};
use serde_json::{json, Value};

// ---------------------------------------------------------------------------
// Fixtures

#[derive(Clone, Debug)]
struct RecordedRequest {
    method: String,
    path: String,
    query: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

#[derive(Clone, Debug)]
struct StubResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

type StubHandler = Arc<dyn Fn(&RecordedRequest) -> StubResponse + Send + Sync>;
type RecordedCommands = Arc<Mutex<Vec<(Vec<String>, Environment)>>>;

#[derive(Clone)]
struct StubState {
    handler: StubHandler,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
}

async fn stub_entry(
    State(state): State<StubState>,
    request: axum::extract::Request,
) -> axum::response::Response {
    let method = request.method().as_str().to_string();
    let uri = request.uri().clone();
    let headers = request
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_ascii_lowercase(),
                value.to_str().unwrap_or("").to_string(),
            )
        })
        .collect();
    let body = axum::body::to_bytes(request.into_body(), usize::MAX)
        .await
        .unwrap_or_default()
        .to_vec();
    let record = RecordedRequest {
        method,
        path: uri.path().to_string(),
        query: uri.query().unwrap_or("").to_string(),
        headers,
        body,
    };
    state
        .requests
        .lock()
        .expect("requests")
        .push(record.clone());
    let answer = (state.handler)(&record);
    let mut builder = axum::response::Response::builder().status(answer.status);
    for (name, value) in &answer.headers {
        builder = builder.header(name, value);
    }
    builder
        .body(axum::body::Body::from(answer.body))
        .expect("a stub response")
}

struct StubServer {
    base: String,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
    handle: tokio::task::JoinHandle<()>,
}

impl StubServer {
    async fn start(
        handler: impl Fn(&RecordedRequest) -> StubResponse + Send + Sync + 'static,
    ) -> Self {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let state = StubState {
            handler: Arc::new(handler),
            requests: requests.clone(),
        };
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("a stub listener");
        let port = listener.local_addr().expect("an address").port();
        let app = axum::Router::new().fallback(stub_entry).with_state(state);
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self {
            base: format!("http://127.0.0.1:{port}"),
            requests,
            handle,
        }
    }

    fn port(&self) -> u16 {
        self.base
            .rsplit(':')
            .next()
            .and_then(|value| value.parse().ok())
            .expect("a port")
    }

    fn requests(&self) -> Vec<RecordedRequest> {
        self.requests.lock().expect("requests").clone()
    }

    fn find(&self, method: &str, path: &str) -> Option<RecordedRequest> {
        self.requests()
            .into_iter()
            .find(|request| request.method == method && request.path == path)
    }

    fn count(&self) -> usize {
        self.requests.lock().expect("requests").len()
    }
}

impl Drop for StubServer {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

fn json_response(value: Value) -> StubResponse {
    StubResponse {
        status: 200,
        headers: vec![("content-type".to_string(), "application/json".to_string())],
        body: value.to_string(),
    }
}

fn text_response(status: u16, body: &str) -> StubResponse {
    StubResponse {
        status,
        headers: vec![("content-type".to_string(), "text/plain".to_string())],
        body: body.to_string(),
    }
}

fn temp_dir(label: &str) -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("forge-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("a fixture root");
    root
}

fn git_repo(label: &str, remote: &str) -> PathBuf {
    let root = temp_dir(label);
    let status = Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["init", "-q"])
        .status()
        .expect("git init");
    assert!(status.success());
    let status = Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["remote", "add", "origin", remote])
        .status()
        .expect("git remote add");
    assert!(status.success());
    root
}

fn issue_value(number: i64, title: &str, state: &str) -> Value {
    json!({
        "number": number,
        "title": title,
        "html_url": format!("https://gitea.test/owner/name/issues/{number}"),
        "created_at": "2024-01-02T03:04:05Z",
        "closed_at": if state == "closed" { Value::String("2024-01-03T03:04:05Z".to_string()) } else { Value::Null },
        "state": state,
        "body": format!("body {number}"),
        "labels": [{"name": "processing"}, "bug"],
    })
}

// ---------------------------------------------------------------------------
// Origin parsing

#[test]
fn origin_parsing_covers_github_gitlab_and_gitea_forms() {
    let env = environment(&[]);

    let github = parse_forge_remote("git@github.com:owner/name.git", &env).expect("github scp");
    assert_eq!(github.forge, Forge::GitHub);
    assert_eq!(github.host, "github.com");
    assert_eq!(github.project, "owner/name");
    assert_eq!(github.origin_url, None);

    let https =
        parse_forge_remote("https://github.com/owner/name.git", &env).expect("github https");
    assert_eq!(https.origin_url.as_deref(), Some("https://github.com"));

    let gitlab =
        parse_forge_remote("https://gitlab.com/group/sub/project.git", &env).expect("gitlab https");
    assert_eq!(gitlab.forge, Forge::GitLab);
    assert_eq!(gitlab.project, "group/sub/project");
    assert_eq!(gitlab.origin_url.as_deref(), Some("https://gitlab.com"));

    let gitlab_ssh = parse_forge_remote("ssh://git@gitlab.example.com/group/sub/project.git", &env)
        .expect("gitlab ssh");
    assert_eq!(gitlab_ssh.forge, Forge::GitLab);
    assert_eq!(gitlab_ssh.project, "group/sub/project");
    assert_eq!(gitlab_ssh.origin_url, None);

    let gitea =
        parse_forge_remote("git@gitea.example.com:owner/name.git", &env).expect("gitea scp");
    assert_eq!(gitea.forge, Forge::Gitea);
    assert_eq!(gitea.host, "gitea.example.com");
    assert_eq!(gitea.project, "owner/name");

    let nested = parse_forge_remote("https://host.example.com/gitea/owner/name.git", &env)
        .expect("gitea prefix");
    assert_eq!(
        nested.origin_url.as_deref(),
        Some("https://host.example.com/gitea")
    );
    assert_eq!(nested.project, "owner/name");

    assert!(parse_forge_remote("/srv/repos/name", &env).is_none());
    assert!(parse_forge_remote("./name", &env).is_none());
    assert!(parse_forge_remote("https://github.com/owner", &env).is_none());
    assert!(parse_forge_remote("https://github.com/own er/name", &env).is_none());
    assert!(parse_forge_remote("file:///srv/name", &env).is_none());

    let forced = environment(&[("DEVBOARD_FORGE", "gitea")]);
    let pinned = parse_forge_remote("git@github.com:owner/name.git", &forced).expect("forced");
    assert_eq!(pinned.forge, Forge::Gitea);

    let gitlab_host = environment(&[]);
    assert_eq!(
        parse_forge_remote("https://code.gitlab.example.com/o/n.git", &gitlab_host)
            .expect("gitlab host")
            .forge,
        Forge::GitLab
    );
    assert_eq!(
        project_from_path("/owner/name.git", Forge::GitHub).as_deref(),
        Some("owner/name")
    );
    assert_eq!(
        project_from_path("/a/b/c", Forge::GitLab).as_deref(),
        Some("a/b/c")
    );
}

#[test]
fn configured_gitea_address_and_token_follow_the_documented_order() {
    let env = environment(&[
        ("DEVBOARD_GITEA_URL", " https://configured.test/// "),
        ("GITEA_URL", "https://ignored.test"),
        ("GITEA_TOKEN", " first "),
        ("DEVBOARD_GITEA_TOKEN", "second"),
    ]);
    assert_eq!(
        configured_gitea_url(&env).as_deref(),
        Some("https://configured.test")
    );
    assert_eq!(configured_gitea_token(&env).as_deref(), Some("first"));

    let fallback = environment(&[("GITEA_URL", "https://fallback.test/")]);
    assert_eq!(
        configured_gitea_url(&fallback).as_deref(),
        Some("https://fallback.test")
    );

    let remote =
        parse_forge_remote("https://gitea.test/owner/name.git", &environment(&[])).expect("remote");
    assert_eq!(
        gitea_base_url(Some(&remote), &environment(&[])).as_deref(),
        Some("https://gitea.test")
    );
    let ssh = parse_forge_remote("git@gitea.test:owner/name.git", &environment(&[])).expect("ssh");
    assert_eq!(gitea_base_url(Some(&ssh), &environment(&[])), None);
    let configured = environment(&[("DEVBOARD_GITEA_URL", "https://override.test")]);
    assert_eq!(
        gitea_base_url(Some(&remote), &configured).as_deref(),
        Some("https://override.test")
    );
}

#[test]
fn origin_forge_reads_the_checkout_origin_and_refuses_a_subdirectory() {
    let repo = git_repo("origin", "git@github.com:owner/name.git");
    let env = environment(&[]);
    let remote = origin_forge_with(&repo, &env).expect("origin forge");
    assert_eq!(remote.forge, Forge::GitHub);
    assert_eq!(remote.project, "owner/name");
    assert_eq!(
        origin_repository_with(&repo, &env).as_deref(),
        Some("owner/name")
    );

    let nested = repo.join("nested");
    std::fs::create_dir_all(&nested).expect("a nested directory");
    assert!(origin_forge_with(&nested, &env).is_none());
    // `originRepository` reads the remote URL alone; git still finds it from a
    // subdirectory. Only `originForge` refuses to inherit the checkout root.
    assert_eq!(origin_repository(&nested).as_deref(), Some("owner/name"));
}

// ---------------------------------------------------------------------------
// Gitea REST

#[test]
fn gitea_target_requires_project_and_address_and_trims() {
    let env = environment(&[
        ("DEVBOARD_GITEA_URL", "https://gitea.test/"),
        ("GITEA_TOKEN", " tok "),
    ]);
    let target = gitea_target(None, Some("owner/name"), None, None, &env).expect("target");
    assert_eq!(target.base_url, "https://gitea.test");
    assert_eq!(target.project, "owner/name");
    assert_eq!(target.token.as_deref(), Some("tok"));

    let missing_project = gitea_target(None, Some("  "), Some("https://gitea.test"), None, &env)
        .expect_err("project");
    assert_eq!(
        missing_project.message,
        "the Gitea repository is not configured"
    );

    let missing_address =
        gitea_target(None, Some("owner/name"), None, None, &environment(&[])).expect_err("address");
    assert_eq!(
        missing_address.message,
        "the Gitea address (set DEVBOARD_GITEA_URL) is not configured"
    );

    let remote =
        parse_forge_remote("https://gitea.test/owner/name.git", &environment(&[])).expect("remote");
    let from_remote = gitea_target(
        Some(&remote),
        None,
        None,
        Some("explicit"),
        &environment(&[]),
    )
    .expect("remote target");
    assert_eq!(from_remote.project, "owner/name");
    assert_eq!(from_remote.token.as_deref(), Some("explicit"));
    assert_eq!(gitea_authorization("abc"), "token abc");
}

#[tokio::test]
async fn gitea_requests_carry_the_default_timeout_and_flow_id() {
    let seen: Arc<Mutex<Vec<HttpRequest>>> = Arc::new(Mutex::new(Vec::new()));
    let captured = seen.clone();
    let transport: Transport = Arc::new(move |request| {
        captured.lock().expect("requests").push(request);
        Box::pin(async {
            Ok(HttpResponse {
                status: 200,
                headers: vec![("content-type".to_string(), "application/json".to_string())],
                body: b"{}".to_vec(),
            })
        })
    });
    let target = GiteaTarget {
        base_url: "http://gitea.test".to_string(),
        project: "owner/name".to_string(),
        token: Some("t".to_string()),
    };
    gitea_json(
        &target,
        "/probe",
        None,
        &transport,
        &GiteaCallOptions::with_flow_id("flow"),
    )
    .await
    .expect("json");
    let requests = seen.lock().expect("requests");
    assert_eq!(requests[0].method, "GET");
    assert_eq!(requests[0].url, "http://gitea.test/api/v1/probe");
    assert_eq!(requests[0].timeout_ms, Some(GITEA_REQUEST_TIMEOUT_MS));
    assert_eq!(
        requests[0]
            .headers
            .iter()
            .find(|(name, _)| name == "X-Flow-ID")
            .map(|(_, value)| value.as_str()),
        Some("flow")
    );
    assert_eq!(
        requests[0]
            .headers
            .iter()
            .find(|(name, _)| name == "Authorization")
            .map(|(_, value)| value.as_str()),
        Some("token t")
    );
}

#[tokio::test]
async fn gitea_transport_failures_name_the_request_and_stay_transient() {
    let target = GiteaTarget {
        base_url: "http://gitea.test".to_string(),
        project: "owner/name".to_string(),
        token: Some("t".to_string()),
    };
    let timed_out: Transport = Arc::new(|_| Box::pin(async { Err(HttpError::Timeout) }));
    let error = gitea_json(
        &target,
        "/repos/owner/name/issues",
        None,
        &timed_out,
        &GiteaCallOptions::default(),
    )
    .await
    .expect_err("timeout");
    assert_eq!(error.status, None);
    assert_eq!(
        error.message,
        "GET /repos/owner/name/issues failed: the request timed out after 30000 ms"
    );
    // The page publishes this reason, so it must still classify as a transport
    // failure the shared retry schedule retries rather than a permanent one.
    assert_eq!(
        classify_forge_read_failure(&error.message),
        ForgeReadFailureKind::Transient
    );

    let unreachable: Transport = Arc::new(|_| {
        Box::pin(async {
            Err(HttpError::Unreachable(
                "error sending request for url (http://gitea.test/api/v1/x)".to_string(),
            ))
        })
    });
    let error = gitea_json(
        &target,
        "/repos/owner/name/x",
        None,
        &unreachable,
        &GiteaCallOptions::default(),
    )
    .await
    .expect_err("unreachable");
    assert_eq!(
        error.message,
        "GET /repos/owner/name/x failed: error sending request for url \
         (http://gitea.test/api/v1/x)"
    );
}

/// A read that ran out of time is latency, not a fault: its requests were still
/// in flight, and a periodic read must keep its last rows and read again on its
/// normal cadence instead of raising the error notification that files a board
/// issue.
#[test]
fn a_read_that_ran_out_of_time_is_latency_rather_than_a_fault() {
    assert!(is_forge_read_latency(
        "the forge read did not finish within 30000 ms"
    ));
    assert!(is_forge_read_latency(
        "GET /repos/owner/name/issues failed: the request timed out after 30000 ms"
    ));
    assert!(!is_forge_read_latency(
        "GET /repos/owner/name/issues failed: error sending request for url \
         (http://gitea.test/api/v1/x)"
    ));
    assert!(!is_forge_read_latency(
        "GET /repos/owner/name/issues failed: HTTP 500 internal server error"
    ));
    assert!(!is_forge_read_latency("bad credentials"));
}

/// A read the forge could not answer — a `5xx`, a reset connection, or nothing
/// at all — is an unavailable forge, not a refused read. The cycle defers on it
/// instead of raising the error notification that files a board issue, while a
/// `4xx` refusal the forge actually answered still fails.
#[test]
fn a_read_the_forge_could_not_answer_is_an_outage_rather_than_a_refusal() {
    assert!(is_forge_read_outage(
        "GET /repos/owner/name/issues?state=open&type=issues&limit=50&page=1 failed (HTTP 500): \
         {\"message\":\"\",\"url\":\"http://gitea.test/api/swagger\"}"
    ));
    assert!(is_forge_read_outage(
        "GET /repos/owner/name/issues failed: the request timed out after 30000 ms"
    ));
    assert!(is_forge_read_outage(
        "GET /repos/owner/name/issues failed: error sending request for url \
         (http://gitea.test/api/v1/x)"
    ));
    assert!(!is_forge_read_outage(
        "GET /repos/owner/name/issues failed (HTTP 401): invalid username, password or token"
    ));
    assert!(!is_forge_read_outage(
        "GET /repos/owner/name/issues/404 failed (HTTP 404): not found"
    ));
    assert!(!is_forge_read_outage(
        "GET /repos/owner/name/issues failed (HTTP 429): Too Many Requests"
    ));
}

#[tokio::test]
async fn gitea_rest_uses_the_contract_paths_headers_and_bodies() {
    let server = StubServer::start(|request| {
        let path = request.path.as_str();
        match (request.method.as_str(), path) {
            ("GET", "/api/v1/repos/owner/name") => json_response(json!({
                "full_name": "owner/name",
                "private": false,
                "permissions": {"pull": true, "push": true, "admin": false},
            })),
            ("GET", "/api/v1/user") => json_response(json!({"login": "alice"})),
            ("GET", "/api/v1/repos/owner/name/issues") => {
                if request.query.contains("page=1") {
                    json_response(json!([
                        issue_value(1, "One", "open"),
                        issue_value(2, "Two", "open")
                    ]))
                } else if request.query.contains("page=2") {
                    json_response(json!([
                        issue_value(2, "Two", "open"),
                        issue_value(3, "Three", "open")
                    ]))
                } else {
                    json_response(json!([]))
                }
            }
            ("GET", "/api/v1/repos/owner/name/issues/7") => {
                json_response(issue_value(7, "Seven", "closed"))
            }
            ("GET", "/api/v1/repos/owner/name/issues/404") => StubResponse {
                status: 404,
                headers: vec![("content-type".to_string(), "application/json".to_string())],
                body: json!({"message": "not found"}).to_string(),
            },
            ("POST", "/api/v1/repos/owner/name/issues") => {
                json_response(issue_value(11, "Created", "open"))
            }
            ("PATCH", "/api/v1/repos/owner/name/issues/7") => json_response(json!({})),
            ("POST", "/api/v1/repos/owner/name/issues/7/labels") => json_response(json!({})),
            ("DELETE", "/api/v1/repos/owner/name/issues/7/labels/3") => json_response(json!({})),
            ("GET", "/api/v1/repos/owner/name/labels") => {
                if request.query.contains("page=1") {
                    json_response(json!([{"id": 3, "name": "processing"}]))
                } else {
                    json_response(json!([]))
                }
            }
            ("POST", "/api/v1/repos/owner/name/labels") => {
                json_response(json!({"id": 12, "name": "new"}))
            }
            ("GET", "/api/v1/repos/owner/name/pulls/9") => json_response(json!({
                "number": 9,
                "html_url": "https://gitea.test/owner/name/pulls/9",
                "state": "open",
                "merged": false,
                "merged_at": null,
                "title": "WIP: Ready",
            })),
            ("PATCH", "/api/v1/repos/owner/name/pulls/9") => json_response(json!({})),
            ("POST", "/api/v1/repos/owner/name/pulls/9/merge") => json_response(json!({})),
            ("GET", "/api/v1/repos/owner/name/bad") => text_response(200, "not json"),
            ("GET", "/api/v1/repos/owner/name/outage") => text_response(
                500,
                r#"{"message":"","url":"http://gitea.test/api/swagger"}"#,
            ),
            _ => text_response(500, "unexpected"),
        }
    })
    .await;
    let target = GiteaTarget {
        base_url: server.base.clone(),
        project: "owner/name".to_string(),
        token: Some("secret".to_string()),
    };
    let transport = default_transport(5_000);
    let options = GiteaCallOptions::default();

    let repository = gitea_repository(&target, &transport, &options)
        .await
        .expect("repo");
    assert_eq!(repository.full_name(), Some("owner/name"));
    assert!(!repository.private());
    let repo_request = server
        .find("GET", "/api/v1/repos/owner/name")
        .expect("repo request");
    assert_eq!(
        repo_request
            .headers
            .get("authorization")
            .map(String::as_str),
        Some("token secret")
    );
    assert_eq!(
        repo_request.headers.get("accept").map(String::as_str),
        Some("application/json")
    );

    assert_eq!(
        gitea_user(&target, &transport, &options)
            .await
            .expect("user"),
        "alice"
    );

    let issues = gitea_list_issues(&target, IssueQueryState::Open, &transport, &options)
        .await
        .expect("issues");
    assert_eq!(
        issues.iter().map(|issue| issue.number).collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
    let first_page = server
        .find("GET", "/api/v1/repos/owner/name/issues")
        .expect("issue page");
    assert_eq!(first_page.query, "state=open&type=issues&limit=50&page=1");

    let issue = gitea_issue(&target, 7, &transport, &options)
        .await
        .expect("issue");
    assert_eq!(issue.title, "Seven");
    assert_eq!(issue.state, IssueState::Closed);
    assert_eq!(
        issue.labels,
        vec!["processing".to_string(), "bug".to_string()]
    );
    assert_eq!(issue.closed_at.as_deref(), Some("2024-01-03T03:04:05Z"));

    let created = gitea_create_issue(
        &target,
        &CreateIssueInput {
            title: "T".to_string(),
            body: "B".to_string(),
            labels: Some(vec![3]),
        },
        &transport,
        &options,
    )
    .await
    .expect("create");
    assert_eq!(created.number, 11);
    let create_request = server
        .find("POST", "/api/v1/repos/owner/name/issues")
        .expect("create request");
    assert_eq!(
        create_request
            .headers
            .get("content-type")
            .map(String::as_str),
        Some("application/json")
    );
    assert_eq!(
        String::from_utf8(create_request.body).expect("utf8"),
        r#"{"title":"T","body":"B","labels":[3]}"#
    );

    gitea_close_issue(&target, 7, &transport, &options)
        .await
        .expect("close");
    let close_request = server
        .find("PATCH", "/api/v1/repos/owner/name/issues/7")
        .expect("close request");
    assert_eq!(
        String::from_utf8(close_request.body).expect("utf8"),
        r#"{"state":"closed"}"#
    );

    gitea_add_issue_label(&target, 7, 3, &transport, &options)
        .await
        .expect("add label");
    let add = server
        .find("POST", "/api/v1/repos/owner/name/issues/7/labels")
        .expect("add label request");
    assert_eq!(
        String::from_utf8(add.body).expect("utf8"),
        r#"{"labels":[3]}"#
    );

    let flow = GiteaCallOptions::with_flow_id("flow-1");
    gitea_add_issue_label(&target, 7, 3, &transport, &flow)
        .await
        .expect("add label with flow id");
    let flowed = server
        .requests()
        .into_iter()
        .filter(|request| request.path == "/api/v1/repos/owner/name/issues/7/labels")
        .next_back()
        .expect("flowed request");
    assert_eq!(
        flowed.headers.get("x-flow-id").map(String::as_str),
        Some("flow-1")
    );

    gitea_remove_issue_label(&target, 7, 3, &transport, &options)
        .await
        .expect("remove label");
    let remove = server
        .find("DELETE", "/api/v1/repos/owner/name/issues/7/labels/3")
        .expect("remove label request");
    assert!(remove.body.is_empty());

    assert_eq!(
        gitea_ensure_label(
            &target,
            "processing",
            "color",
            "description",
            &transport,
            &options
        )
        .await
        .expect("existing label"),
        3
    );
    assert!(server
        .find("POST", "/api/v1/repos/owner/name/labels")
        .is_none());
    assert_eq!(
        gitea_ensure_label(&target, "new", "color", "description", &transport, &options)
            .await
            .expect("created label"),
        12
    );
    let label_create = server
        .find("POST", "/api/v1/repos/owner/name/labels")
        .expect("label create");
    assert_eq!(
        String::from_utf8(label_create.body).expect("utf8"),
        r#"{"name":"new","color":"color","description":"description"}"#
    );

    let pull = gitea_pull(&target, 9, &transport, &options)
        .await
        .expect("pull");
    assert_eq!(pull.state, PullState::Open);
    assert!(pull.draft);
    assert_eq!(pull.title, "WIP: Ready");
    gitea_merge_pull(&target, 9, &transport, &options)
        .await
        .expect("merge");
    let merge = server
        .find("POST", "/api/v1/repos/owner/name/pulls/9/merge")
        .expect("merge request");
    assert_eq!(
        String::from_utf8(merge.body).expect("utf8"),
        r#"{"Do":"merge"}"#
    );
    gitea_ready_pull(&target, 9, &transport, &options)
        .await
        .expect("ready");
    let edit = server
        .find("PATCH", "/api/v1/repos/owner/name/pulls/9")
        .expect("ready request");
    assert_eq!(
        String::from_utf8(edit.body).expect("utf8"),
        r#"{"title":"Ready"}"#
    );

    let missing = gitea_issue(&target, 404, &transport, &options)
        .await
        .expect_err("missing");
    assert_eq!(missing.status, Some(404));
    assert_eq!(
        missing.message,
        "GET /repos/owner/name/issues/404 failed (HTTP 404): not found"
    );

    let bad = gitea_json(&target, "/repos/owner/name/bad", None, &transport, &options)
        .await
        .expect_err("invalid json");
    assert_eq!(
        bad.message,
        "GET /repos/owner/name/bad returned invalid JSON: not json"
    );

    // A Gitea internal failure answers `{"message":"",...}`: the diagnostic must
    // not end at its colon with the fault unnamed.
    let outage = gitea_json(
        &target,
        "/repos/owner/name/outage",
        None,
        &transport,
        &options,
    )
    .await
    .expect_err("a forge failure");
    assert_eq!(outage.status, Some(500));
    assert_eq!(
        outage.message,
        "GET /repos/owner/name/outage failed (HTTP 500): \
         {\"message\":\"\",\"url\":\"http://gitea.test/api/swagger\"}"
    );
}

#[test]
fn gitea_origin_and_issue_urls_fold_loopback_aliases() {
    let target = GiteaTarget {
        base_url: "http://localhost:3000".to_string(),
        project: "owner/name".to_string(),
        token: None,
    };
    assert_eq!(
        gitea_origin("http://127.0.0.1:3000/"),
        Some("http://loopback:3000".to_string())
    );
    assert_eq!(
        gitea_issue_number(&target, "http://127.0.0.1:3000/owner/name/issues/5"),
        Some(5)
    );
    assert_eq!(
        gitea_issue_number(&target, "https://127.0.0.1:3000/owner/name/issues/5"),
        None
    );
    assert_eq!(
        gitea_issue_number(&target, "http://localhost:3000/other/name/issues/5"),
        None
    );
    assert_eq!(
        gitea_issue_number(&target, "http://localhost:3000/owner/name/issues/5/"),
        Some(5)
    );
    assert_eq!(issue_number_from_url("https://host/x/issues/0"), None);
    assert_eq!(issue_number_from_url("https://host/x/pull/5"), None);
}

// ---------------------------------------------------------------------------
// Credentials

#[tokio::test]
async fn gitea_auth_resolves_through_the_api_and_refuses_with_the_contract_text() {
    let server = StubServer::start(|request| match request.path.as_str() {
        "/api/v1/repos/owner/name" => json_response(json!({
            "permissions": {"pull": true, "push": false, "admin": false},
        })),
        "/api/v1/user" => json_response(json!({"login": "alice"})),
        _ => text_response(500, "unexpected"),
    })
    .await;
    let exec = default_exec();
    let mut options =
        ResolveOptions::new(Forge::Gitea, "localhost", "owner/name", temp_dir("auth"));
    options.env = environment(&[("GITEA_TOKEN", "secret")]);
    options.base_url = Some(server.base.clone());
    options.gitea_transport = Some(default_transport(5_000));

    let auth = resolve_forge_auth(&exec, &options)
        .await
        .into_result()
        .expect("resolved auth");
    assert_eq!(auth.login, "alice");
    assert_eq!(auth.token.as_deref(), Some("secret"));
    assert_eq!(auth.source, "GITEA_TOKEN");
    assert_eq!(auth.permission, Permission::Pull);
    assert!(!auth.can_write);
    assert_eq!(auth.base_url.as_deref(), Some(server.base.as_str()));

    let mut write = options.clone();
    write.required = RequiredAccess::Write;
    let refused = resolve_forge_auth(&exec, &write)
        .await
        .into_result()
        .expect_err("write refusal");
    assert_eq!(
        refused.error,
        format!(
            "the Gitea account alice cannot write to owner/name on {}",
            server.base
        )
    );

    let mut anonymous = options.clone();
    anonymous.env = environment(&[]);
    let public = resolve_forge_auth(&exec, &anonymous)
        .await
        .into_result()
        .expect("anonymous read");
    assert_eq!(public.login, "anonymous");
    assert_eq!(public.source, "public repository");
    assert_eq!(public.token, None);

    anonymous.required = RequiredAccess::Write;
    let refused = resolve_forge_auth(&exec, &anonymous)
        .await
        .into_result()
        .expect_err("anonymous write");
    assert_eq!(
        refused.error,
        format!(
            "no Gitea credential is configured for owner/name on {}; writing needs GITEA_TOKEN",
            server.base
        )
    );

    let mut missing = options.clone();
    missing.base_url = None;
    missing.env = environment(&[]);
    let refused = resolve_forge_auth(&exec, &missing)
        .await
        .into_result()
        .expect_err("missing address");
    assert_eq!(
        refused.error,
        "no Gitea address is configured for localhost; set DEVBOARD_GITEA_URL"
    );
}

#[tokio::test]
async fn a_refused_credential_resolves_a_public_repository_anonymously() {
    let server = StubServer::start(|request| {
        if request.headers.contains_key("authorization") {
            return text_response(401, r#"{"message":"invalid username, password or token"}"#);
        }
        match request.path.as_str() {
            "/api/v1/repos/owner/name" => json_response(json!({
                "permissions": {"pull": true, "push": false, "admin": false},
            })),
            _ => text_response(500, "unexpected anonymous request"),
        }
    })
    .await;
    let exec = default_exec();
    let mut options = ResolveOptions::new(
        Forge::Gitea,
        "localhost",
        "owner/name",
        temp_dir("auth-refused"),
    );
    options.env = environment(&[("GITEA_TOKEN", "secret")]);
    options.base_url = Some(server.base.clone());
    options.gitea_transport = Some(default_transport(5_000));

    // The probe presents the credential and is refused, the anonymous probe
    // reads the public view, and the account probe is never attempted with a
    // credential the forge already refused.
    let auth = resolve_forge_auth(&exec, &options)
        .await
        .into_result()
        .expect("the public view resolves");
    assert_eq!(auth.login, "anonymous");
    assert_eq!(auth.token, None);
    assert_eq!(auth.source, "public repository");
    assert_eq!(auth.permission, Permission::Pull);
    assert!(!auth.can_write);
    let probes: Vec<RecordedRequest> = server
        .requests()
        .into_iter()
        .filter(|request| request.path == "/api/v1/repos/owner/name")
        .collect();
    assert_eq!(probes.len(), 2);
    assert_eq!(
        probes[0].headers.get("authorization").map(String::as_str),
        Some("token secret")
    );
    assert!(!probes[1].headers.contains_key("authorization"));

    // A write has no anonymous form: the refusal is named, never a missing
    // credential, because one was configured and the forge refused it.
    options.required = RequiredAccess::Write;
    let refused = resolve_forge_auth(&exec, &options)
        .await
        .into_result()
        .expect_err("write refusal");
    assert_eq!(
        refused.error,
        format!(
            "the Gitea credential was refused for owner/name on {}: GET /repos/owner/name failed (HTTP 401): invalid username, password or token; writing needs a token the forge accepts",
            server.base
        )
    );
}

#[tokio::test]
async fn a_refused_account_probe_resolves_a_public_repository_anonymously() {
    let server = StubServer::start(|request| match request.path.as_str() {
        // The repository view answers the credential and the public view
        // alike, while the same credential is refused at the account probe:
        // what a token sees while Gitea's access-token store cannot answer.
        "/api/v1/repos/owner/name" => json_response(json!({
            "permissions": {"pull": true, "push": false, "admin": false},
        })),
        "/api/v1/user" => {
            text_response(401, r#"{"message":"invalid username, password or token"}"#)
        }
        _ => text_response(500, "unexpected"),
    })
    .await;
    let exec = default_exec();
    let mut options = ResolveOptions::new(
        Forge::Gitea,
        "localhost",
        "owner/name",
        temp_dir("auth-refused-account"),
    );
    options.env = environment(&[("GITEA_TOKEN", "secret")]);
    options.base_url = Some(server.base.clone());
    options.gitea_transport = Some(default_transport(5_000));

    // The account refusal is no proof the repository is unreadable, so the read
    // resolves to the public view instead of failing as a Watchdog
    // deduplication turn's `issues_list` did.
    let auth = resolve_forge_auth(&exec, &options)
        .await
        .into_result()
        .expect("the public view resolves");
    assert_eq!(auth.login, "anonymous");
    assert_eq!(auth.token, None);
    assert_eq!(auth.source, "public repository");
    assert_eq!(auth.permission, Permission::Pull);
    assert!(!auth.can_write);
    let probes: Vec<RecordedRequest> = server
        .requests()
        .into_iter()
        .filter(|request| request.path == "/api/v1/repos/owner/name")
        .collect();
    assert_eq!(probes.len(), 2, "one credential read, one anonymous read");
    assert_eq!(
        probes[0].headers.get("authorization").map(String::as_str),
        Some("token secret")
    );
    assert!(!probes[1].headers.contains_key("authorization"));
    assert_eq!(
        server
            .requests()
            .iter()
            .filter(|request| request.path == "/api/v1/user")
            .count(),
        1,
        "the refused account is probed once, never with the refused credential again"
    );

    // A write has no anonymous form: the account refusal is named.
    options.required = RequiredAccess::Write;
    let refused = resolve_forge_auth(&exec, &options)
        .await
        .into_result()
        .expect_err("write refusal");
    assert_eq!(
        refused.error,
        format!(
            "the Gitea credential was refused for owner/name on {}: GET /user failed (HTTP 401): invalid username, password or token; writing needs a token the forge accepts",
            server.base
        )
    );
}

#[test]
fn auth_environment_pins_the_selected_identity() {
    let base = environment(&[
        ("GH_TOKEN", "ambient"),
        ("GITHUB_TOKEN", "ambient"),
        ("NO_COLOR", ""),
    ]);
    let github = ResolvedAuth {
        forge: Forge::GitHub,
        host: "github.com".to_string(),
        project: "owner/name".to_string(),
        login: "alice".to_string(),
        token: Some("selected".to_string()),
        source: "gh account".to_string(),
        base_url: None,
        active: true,
        permission: Permission::Push,
        can_write: true,
    };
    let environment = auth_environment(&github, &base).expect("github env");
    assert_eq!(
        environment.get("GH_TOKEN").map(String::as_str),
        Some("selected")
    );
    assert_eq!(environment.get("GITHUB_TOKEN"), None);
    assert_eq!(
        environment.get("GH_HOST").map(String::as_str),
        Some("github.com")
    );
    assert_eq!(
        environment.get("GH_PROMPT_DISABLED").map(String::as_str),
        Some("1")
    );

    let gitlab = ResolvedAuth {
        forge: Forge::GitLab,
        host: "gitlab.test".to_string(),
        token: Some("gl".to_string()),
        ..github.clone()
    };
    let environment = auth_environment(&gitlab, &base).expect("gitlab env");
    assert_eq!(
        environment.get("GITLAB_TOKEN").map(String::as_str),
        Some("gl")
    );
    assert_eq!(
        environment.get("GITLAB_HOST").map(String::as_str),
        Some("gitlab.test")
    );

    let gitea = ResolvedAuth {
        forge: Forge::Gitea,
        host: "localhost".to_string(),
        token: Some("g".to_string()),
        base_url: Some("https://gitea.test".to_string()),
        ..github.clone()
    };
    let environment = auth_environment(&gitea, &base).expect("gitea env");
    assert_eq!(
        environment.get("GITEA_TOKEN").map(String::as_str),
        Some("g")
    );
    assert_eq!(
        environment.get("DEVBOARD_GITEA_URL").map(String::as_str),
        Some("https://gitea.test")
    );

    let tokenless = ResolvedAuth {
        forge: Forge::GitHub,
        token: None,
        ..github
    };
    assert!(auth_environment(&tokenless, &base).is_err());
}

// ---------------------------------------------------------------------------
// Retry schedule

fn recording_sleep() -> (Sleep, Arc<Mutex<Vec<u64>>>) {
    let delays: Arc<Mutex<Vec<u64>>> = Arc::new(Mutex::new(Vec::new()));
    let seen = delays.clone();
    let sleep: Sleep = Arc::new(move |millis| {
        seen.lock().expect("delays").push(millis);
        Box::pin(async {})
    });
    (sleep, delays)
}

#[tokio::test]
async fn read_retry_uses_the_documented_delays_and_stops_on_permanent_failures() {
    assert_eq!(FORGE_READ_RETRY_DELAYS_MS, [1_000, 2_000, 4_000, 8_000]);
    assert_eq!(FORGE_READ_MAX_ATTEMPTS, 5);
    assert_eq!(
        classify_forge_read_failure("HTTP 429 Too Many Requests"),
        ForgeReadFailureKind::RateLimit
    );
    assert_eq!(
        classify_forge_read_failure("bad credentials"),
        ForgeReadFailureKind::Permanent
    );
    assert_eq!(
        classify_forge_read_failure("connection refused"),
        ForgeReadFailureKind::Transient
    );
    assert_eq!(
        classify_forge_read_failure("something else"),
        ForgeReadFailureKind::Transient
    );

    let mut retry = ForgeReadRetry::new();
    assert_eq!(retry.record(ForgeReadFailureKind::Transient), Some(1_000));
    assert_eq!(retry.record(ForgeReadFailureKind::Transient), Some(2_000));
    assert_eq!(retry.record(ForgeReadFailureKind::Transient), Some(4_000));
    assert_eq!(retry.record(ForgeReadFailureKind::Transient), Some(8_000));
    assert_eq!(retry.record(ForgeReadFailureKind::Transient), None);
    assert_eq!(retry.failures(), 5);
    assert!(retry.exhausted());
    assert_eq!(retry.record(ForgeReadFailureKind::Transient), None);
    retry.succeed();
    assert!(!retry.exhausted());
    assert_eq!(retry.failures(), 0);

    let (sleep, delays) = recording_sleep();
    let attempts = Arc::new(AtomicUsize::new(0));
    let mut retry = ForgeReadRetry::new();
    let counter = attempts.clone();
    let result = read_with_retry(&mut retry, &sleep, move || {
        let counter = counter.clone();
        async move {
            let attempt = counter.fetch_add(1, Ordering::SeqCst) + 1;
            if attempt < 3 {
                Err("connection reset".to_string())
            } else {
                Ok(attempt)
            }
        }
    })
    .await;
    assert_eq!(result, Ok(3));
    assert_eq!(*delays.lock().expect("delays"), vec![1_000, 2_000]);

    let (sleep, delays) = recording_sleep();
    let attempts = Arc::new(AtomicUsize::new(0));
    let mut retry = ForgeReadRetry::new();
    let counter = attempts.clone();
    let result: Result<(), String> = read_with_retry(&mut retry, &sleep, move || {
        let counter = counter.clone();
        async move {
            counter.fetch_add(1, Ordering::SeqCst);
            Err("the operation timed out".to_string())
        }
    })
    .await;
    assert!(result.is_err());
    assert_eq!(attempts.load(Ordering::SeqCst), 5);
    assert_eq!(
        *delays.lock().expect("delays"),
        vec![1_000, 2_000, 4_000, 8_000]
    );

    let (sleep, delays) = recording_sleep();
    let mut retry = ForgeReadRetry::new();
    let result: Result<(), String> = read_with_retry(&mut retry, &sleep, || async {
        Err("HTTP 401 unauthorized".to_string())
    })
    .await;
    assert_eq!(result, Err("HTTP 401 unauthorized".to_string()));
    assert!(delays.lock().expect("delays").is_empty());
}

/// Gitea answers this body when its authentication middleware could not read
/// the token, so one refusal is a forge fault rather than a verdict on the
/// credential and the read spends the shared retry schedule first.
#[tokio::test]
async fn a_gitea_refusal_is_retried_before_a_credential_failure_is_reported() {
    let refused = "GET /repos/owner/name/issues?state=all&type=issues&limit=50&page=1 failed \
                   (HTTP 401): invalid username, password or token";
    assert_eq!(
        classify_forge_read_failure(refused),
        ForgeReadFailureKind::Transient
    );
    // Every other forge keeps its 401 a credential verdict on the first try.
    assert_eq!(
        classify_forge_read_failure(
            "GET /repos/owner/name/issues failed (HTTP 401): Bad credentials"
        ),
        ForgeReadFailureKind::Permanent
    );
    assert_eq!(
        classify_forge_read_failure(
            "GET /api/v4/projects/1/issues failed (HTTP 401): Unauthorized"
        ),
        ForgeReadFailureKind::Permanent
    );

    let (sleep, delays) = recording_sleep();
    let attempts = Arc::new(AtomicUsize::new(0));
    let mut retry = ForgeReadRetry::new();
    let counter = attempts.clone();
    let result = read_with_retry(&mut retry, &sleep, move || {
        let counter = counter.clone();
        async move {
            let attempt = counter.fetch_add(1, Ordering::SeqCst) + 1;
            if attempt == 1 {
                Err(refused.to_string())
            } else {
                Ok(attempt)
            }
        }
    })
    .await;
    assert_eq!(result, Ok(2));
    assert_eq!(*delays.lock().expect("delays"), vec![1_000]);

    // A refusal that never clears is still reported, with its own detail, once
    // the five attempts are spent.
    let (sleep, delays) = recording_sleep();
    let mut retry = ForgeReadRetry::new();
    let result: Result<(), String> =
        read_with_retry(&mut retry, &sleep, || async { Err(refused.to_string()) }).await;
    assert_eq!(result, Err(refused.to_string()));
    assert_eq!(
        *delays.lock().expect("delays"),
        vec![1_000, 2_000, 4_000, 8_000]
    );
}

// ---------------------------------------------------------------------------
// GitHub release reads and version resolution

fn gh_runner(
    requests: RecordedCommands,
    answer: impl Fn(&[String]) -> GitHubCommandOutcome + Send + Sync + 'static,
) -> GitHubCommandRunner {
    Arc::new(move |argv, environment| {
        requests
            .lock()
            .expect("requests")
            .push((argv.clone(), environment));
        let outcome = answer(&argv);
        Box::pin(async move { outcome })
    })
}

#[tokio::test]
async fn github_release_reads_use_the_exact_gh_commands() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let run = gh_runner(requests.clone(), |argv| {
        let endpoint = argv.get(1).map(String::as_str).unwrap_or("");
        if endpoint == "repos/owner/name/releases" {
            GitHubCommandOutcome {
                code: 0,
                stdout: concat!(
                    "{\"tag\":\"v1.2.0\",\"publishedAt\":\"2024-01-02T00:00:00Z\",\"draft\":false}\n",
                    "{\"tag\":\"v1.3.0\",\"publishedAt\":\"2024-02-02T00:00:00Z\",\"draft\":true}\n",
                    "{\"tag\":\"\",\"publishedAt\":\"2024-02-02T00:00:00Z\",\"draft\":false}\n"
                )
                .to_string(),
                stderr: String::new(),
            }
        } else if endpoint == "repos/owner/name/issues/5" {
            GitHubCommandOutcome {
                code: 0,
                stdout: "closed\t2024-01-01T00:00:00Z\t2024-01-03T00:00:00Z\n".to_string(),
                stderr: String::new(),
            }
        } else if endpoint == "repos/owner/name/issues/6" {
            GitHubCommandOutcome {
                code: 0,
                stdout: "pending\tnull\tnull\n".to_string(),
                stderr: String::new(),
            }
        } else if endpoint == "repos/owner/name/issues/7/timeline" {
            GitHubCommandOutcome {
                code: 0,
                stdout: "1111111111111111111111111111111111111111\n".to_string(),
                stderr: String::new(),
            }
        } else if endpoint == "repos/owner/name/commits/abcdef1" {
            GitHubCommandOutcome {
                code: 1,
                stdout: String::new(),
                stderr: "gh: Not Found (HTTP 404)\n".to_string(),
            }
        } else if endpoint == "repos/owner/name/commits/abc1234" {
            GitHubCommandOutcome {
                code: 1,
                stdout: String::new(),
                stderr: "gh: rate limit exceeded (HTTP 403)\n".to_string(),
            }
        } else {
            GitHubCommandOutcome {
                code: 1,
                stdout: String::new(),
                stderr: format!("unexpected {argv:?}"),
            }
        }
    });
    let repo = temp_dir("release-read");
    let reader = RepositoryGitHub::new(RepositoryGitHubOptions {
        repository: "owner/name".to_string(),
        repo_dir: repo,
        run,
        environment: environment(&[("GH_TOKEN", "token")]),
    });

    let releases = reader.list_releases().await.expect("releases");
    assert_eq!(releases.len(), 1);
    assert_eq!(releases[0].tag, "v1.2.0");
    {
        let recorded = requests.lock().expect("requests");
        assert_eq!(
            recorded[0].0,
            vec![
                "api",
                "repos/owner/name/releases",
                "--paginate",
                "--jq",
                ".[] | {tag: .tag_name, publishedAt: .published_at, draft: .draft}",
            ]
        );
        assert_eq!(
            recorded[0].1.get("GH_TOKEN").map(String::as_str),
            Some("token")
        );
    }

    let times = reader.issue_times(5).await.expect("issue times");
    assert_eq!(times.state, IssueState::Closed);
    assert_eq!(times.created_at.as_deref(), Some("2024-01-01T00:00:00Z"));
    assert_eq!(times.closed_at.as_deref(), Some("2024-01-03T00:00:00Z"));
    let error = reader.issue_times(6).await.expect_err("unknown state");
    assert_eq!(error, "gh reported an unknown issue state for owner/name#6");

    let closing = reader.closing_commits(7).await.expect("closing commits");
    assert_eq!(
        closing,
        vec!["1111111111111111111111111111111111111111".to_string()]
    );

    assert_eq!(
        reader.resolve_commit("abcdef1").await.expect("missing"),
        None
    );
    let error = reader
        .resolve_commit("abc1234")
        .await
        .expect_err("rate limit");
    assert_eq!(error, "gh: rate limit exceeded (HTTP 403)");
    assert_eq!(
        reader.resolve_commit("not-a-sha").await.expect("invalid"),
        None
    );
}

struct FakeClient {
    closing: Vec<String>,
    landed: Vec<String>,
    resolved: HashMap<String, String>,
    tags: HashMap<String, Vec<String>>,
}

impl ClosingCommitClient for FakeClient {
    fn closing_commit(&self, _issue_number: i64) -> ClientFuture<'_, Option<String>> {
        let value = self.closing.first().cloned();
        Box::pin(async move { Ok(value) })
    }

    fn closing_commits(&self, _issue_number: i64) -> ClientFuture<'_, Vec<String>> {
        let value = self.closing.clone();
        Box::pin(async move { Ok(value) })
    }

    fn landed_commits(&self, _issue_number: i64) -> Vec<String> {
        self.landed.clone()
    }

    fn resolve_commit(&self, short: String) -> ClientFuture<'_, Option<String>> {
        let value = self.resolved.get(&short).cloned();
        Box::pin(async move { Ok(value) })
    }

    fn containing_release_tags(
        &self,
        commit: String,
        _releases: Vec<GitHubRelease>,
    ) -> ClientFuture<'_, Vec<String>> {
        let value = self.tags.get(&commit).cloned().unwrap_or_default();
        Box::pin(async move { Ok(value) })
    }
}

fn release(tag: &str, published_at: &str) -> GitHubRelease {
    GitHubRelease {
        tag: tag.to_string(),
        published_at: published_at.to_string(),
    }
}

#[tokio::test]
async fn release_resolution_reports_the_exact_shipped_version() {
    let releases = vec![
        release("v1.0.0", "2024-01-01T00:00:00Z"),
        release("v1.1.0", "2024-01-10T00:00:00Z"),
        release("v1.2.0", "2024-01-10T00:00:00Z"),
    ];
    assert_eq!(
        earliest_release(&releases, &["v1.2.0".to_string(), "v1.1.0".to_string()]),
        Some("v1.1.0".to_string())
    );
    assert_eq!(
        release_at_close(
            &releases,
            Some("2023-12-01T00:00:00Z"),
            Some("2024-01-11T00:00:00Z")
        ),
        Some("v1.2.0".to_string())
    );
    assert_eq!(release_at_close(&releases, None, None), None);

    let full = "2222222222222222222222222222222222222222".to_string();
    let client = FakeClient {
        closing: vec![full.clone()],
        landed: Vec::new(),
        resolved: HashMap::from([(full.clone(), full.clone())]),
        tags: HashMap::from([(full.clone(), vec!["v1.1.0".to_string()])]),
    };
    let resolution = resolve_shipped_version(
        &ClosingCommitIssue {
            number: 5,
            state: IssueState::Closed,
            created_at: Some("2024-01-01T00:00:00Z".to_string()),
            closed_at: Some("2024-01-11T00:00:00Z".to_string()),
        },
        &client,
        &releases,
    )
    .await;
    assert_eq!(
        resolution,
        VersionResolution {
            version: Some("v1.1.0".to_string()),
            error: None,
            inferred: false,
        }
    );

    let unresolved = FakeClient {
        closing: Vec::new(),
        landed: Vec::new(),
        resolved: HashMap::new(),
        tags: HashMap::new(),
    };
    let resolution = resolve_shipped_version(
        &ClosingCommitIssue {
            number: 6,
            state: IssueState::Closed,
            created_at: Some("2024-01-01T00:00:00Z".to_string()),
            closed_at: Some("2024-01-11T00:00:00Z".to_string()),
        },
        &unresolved,
        &releases,
    )
    .await;
    assert_eq!(
        resolution,
        VersionResolution {
            version: Some("v1.2.0".to_string()),
            error: None,
            inferred: true,
        }
    );

    let open = resolve_shipped_version(
        &ClosingCommitIssue {
            number: 7,
            state: IssueState::Open,
            created_at: None,
            closed_at: None,
        },
        &unresolved,
        &releases,
    )
    .await;
    assert_eq!(
        open,
        VersionResolution {
            version: None,
            error: None,
            inferred: false,
        }
    );

    let landed_client = FakeClient {
        closing: Vec::new(),
        landed: vec!["3333333333333333333333333333333333333333".to_string()],
        resolved: HashMap::from([(
            "3333333333333333333333333333333333333333".to_string(),
            "3333333333333333333333333333333333333333".to_string(),
        )]),
        tags: HashMap::from([(
            "3333333333333333333333333333333333333333".to_string(),
            vec!["v1.0.0".to_string()],
        )]),
    };
    let resolution = resolve_shipped_version(
        &ClosingCommitIssue {
            number: 8,
            state: IssueState::Closed,
            created_at: Some("2023-01-01T00:00:00Z".to_string()),
            closed_at: Some("2024-01-11T00:00:00Z".to_string()),
        },
        &landed_client,
        &releases,
    )
    .await;
    assert_eq!(resolution.version.as_deref(), Some("v1.0.0"));
    assert!(!resolution.inferred);
}

// ---------------------------------------------------------------------------
// Tracker polling

fn poll_runner(
    stdout: String,
    stderr: String,
    code: i32,
    seen: Arc<Mutex<Vec<Vec<String>>>>,
) -> ForgeRunner {
    Arc::new(move |argv, _stdin, _environment| {
        seen.lock().expect("argv").push(argv);
        let stdout = stdout.clone();
        let stderr = stderr.clone();
        Box::pin(async move {
            Ok(ForgeCommandOutcome {
                code,
                stdout,
                stderr,
            })
        })
    })
}

#[tokio::test]
async fn tracker_poll_handles_conditional_and_rate_limited_answers() {
    let issue_line = json!({
        "number": 4,
        "title": "Four",
        "body": "body",
        "url": "https://github.com/owner/name/issues/4",
        "createdAt": "2024-01-02T00:00:00Z",
        "labels": ["processing"],
    })
    .to_string();
    let stdout =
        format!("HTTP/2.0 200 OK\ncontent-type: application/json\netag: \"abc\"\n\n{issue_line}\n");
    let seen = Arc::new(Mutex::new(Vec::new()));
    let mut options = TrackerOptions::new(Forge::GitHub, "owner/name");
    options.etag = Some("\"old\"".to_string());
    options.run = Some(poll_runner(stdout, String::new(), 0, seen.clone()));
    match poll_open_issues(&options).await {
        PollResult::Issues { issues, etag } => {
            assert_eq!(etag.as_deref(), Some("\"abc\""));
            assert_eq!(issues.len(), 1);
            assert_eq!(issues[0].number, 4);
            assert_eq!(issues[0].labels, vec!["processing".to_string()]);
        }
        other => panic!("expected issues, got {other:?}"),
    }
    let argv = seen.lock().expect("argv")[0].clone();
    assert_eq!(
        argv,
        vec![
            "api",
            "--include",
            "--paginate",
            "-H",
            "If-None-Match: \"old\"",
            "repos/owner/name/issues?state=open&per_page=100",
            "--jq",
            ".[] | select(.pull_request == null) | {number, title, body, url: .html_url, createdAt: .created_at, labels: [.labels[].name]}",
        ]
    );

    let seen = Arc::new(Mutex::new(Vec::new()));
    let mut options = TrackerOptions::new(Forge::GitHub, "owner/name");
    options.run = Some(poll_runner(
        "HTTP/2.0 304 Not Modified\netag: \"same\"\n\n".to_string(),
        String::new(),
        0,
        seen,
    ));
    assert_eq!(
        poll_open_issues(&options).await,
        PollResult::NotModified {
            etag: Some("\"same\"".to_string())
        }
    );

    let seen = Arc::new(Mutex::new(Vec::new()));
    let mut options = TrackerOptions::new(Forge::GitHub, "owner/name");
    options.run = Some(poll_runner(
        "HTTP/2.0 403 Forbidden\nretry-after: 30\n\n".to_string(),
        "HTTP 403: API rate limit exceeded".to_string(),
        1,
        seen,
    ));
    match poll_open_issues(&options).await {
        PollResult::RateLimited { until, detail } => {
            assert_eq!(detail, "HTTP 403: API rate limit exceeded");
            assert!(until.ends_with('Z'));
        }
        other => panic!("expected rate limit, got {other:?}"),
    }

    let seen = Arc::new(Mutex::new(Vec::new()));
    let mut options = TrackerOptions::new(Forge::GitLab, "owner/name");
    options.run = Some(poll_runner(String::new(), String::new(), 0, seen));
    assert_eq!(
        poll_open_issues(&options).await,
        PollResult::Unsupported {
            detail: GITLAB_TRACKER_UNSUPPORTED.to_string()
        }
    );
}

#[tokio::test]
async fn tracker_state_and_processing_writes_use_the_contract_commands() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let mut options = TrackerOptions::new(Forge::GitHub, "owner/name");
    options.run = Some(poll_runner(
        "open\n".to_string(),
        String::new(),
        0,
        seen.clone(),
    ));
    assert_eq!(
        fetch_issue_state(&options, 9).await,
        IssueStateResult::State(IssueState::Open)
    );
    assert_eq!(
        seen.lock().expect("argv")[0],
        vec!["api", "repos/owner/name/issues/9", "--jq", ".state"]
    );

    let seen = Arc::new(Mutex::new(Vec::new()));
    options.run = Some(poll_runner(String::new(), String::new(), 0, seen.clone()));
    assert_eq!(
        write_issue_processing(&options, 9, true).await,
        ProcessingWriteResult::Ok
    );
    let commands = seen.lock().expect("argv").clone();
    assert_eq!(
        commands[0],
        vec![
            "label",
            "create",
            "processing",
            "--repo",
            "owner/name",
            "--color",
            "FBCA04",
            "--description",
            "A Devboard issues run is processing this issue",
            "--force",
        ]
    );
    assert_eq!(
        commands[1],
        vec![
            "issue",
            "edit",
            "9",
            "--add-label",
            "processing",
            "--repo",
            "owner/name",
        ]
    );

    let seen = Arc::new(Mutex::new(Vec::new()));
    options.run = Some(poll_runner(String::new(), String::new(), 0, seen.clone()));
    assert_eq!(
        write_issue_processing(&options, 9, false).await,
        ProcessingWriteResult::Ok
    );
    assert_eq!(
        seen.lock().expect("argv")[0],
        vec![
            "issue",
            "edit",
            "9",
            "--remove-label",
            "processing",
            "--repo",
            "owner/name",
        ]
    );
}

// ---------------------------------------------------------------------------
// Local Gitea discovery

#[test]
fn listening_ports_and_version_documents_are_read_like_the_platform() {
    let table = "\
  sl  local_address rem_address   st\n\
   0: 0100007F:0BB8 00000000:0000 0A\n\
   1: 00000000:1F90 00000000:0000 0A\n\
   2: 0100007F:0035 00000000:0000 01\n\
   3: 00000000:0016 00000000:0000 0A\n";
    assert_eq!(listening_ports_from(table), vec![22, 3000, 8080]);
    assert!(is_gitea_version_document(&json!({"version": "1.21.0"})));
    assert!(!is_gitea_version_document(&json!({"version": "  "})));
    assert!(!is_gitea_version_document(&json!({})));
}

#[tokio::test]
async fn local_gitea_discovery_picks_the_lowest_answering_port() {
    let gitea = StubServer::start(|request| {
        if request.path == "/api/v1/version" {
            StubResponse {
                status: 200,
                headers: vec![(
                    "content-type".to_string(),
                    "application/json; charset=utf-8".to_string(),
                )],
                body: json!({"version": "1.21.0"}).to_string(),
            }
        } else {
            text_response(404, "no")
        }
    })
    .await;
    let plain = StubServer::start(|_| text_response(200, "<html></html>")).await;
    let mut ports = vec![gitea.port(), plain.port()];
    ports.sort_unstable();
    let found = discover_local_gitea(&LocalGiteaOptions {
        ports: Some(ports),
        timeout_ms: Some(1_000),
        transport: Some(default_transport(1_000)),
    })
    .await;
    assert_eq!(found, Some(format!("http://127.0.0.1:{}", gitea.port())));
}

#[tokio::test]
async fn source_checkout_discovery_obeys_every_guard() {
    let gitea = StubServer::start(|request| {
        if request.path == "/api/v1/version" {
            StubResponse {
                status: 200,
                headers: vec![("content-type".to_string(), "application/json".to_string())],
                body: json!({"version": "1.21.0"}).to_string(),
            }
        } else {
            text_response(404, "no")
        }
    })
    .await;
    let repo = git_repo("source-checkout", "git@localhost:owner/name.git");
    let options = SourceCheckoutGiteaOptions {
        repo_dir: repo.clone(),
        environment: environment(&[]),
        source_checkout: Some(true),
        ports: Some(vec![gitea.port()]),
        timeout_ms: Some(1_000),
        transport: Some(default_transport(1_000)),
    };
    assert_eq!(
        source_checkout_gitea_url(&options).await,
        Some(format!("http://127.0.0.1:{}", gitea.port()))
    );

    let mut configured = options.clone();
    configured.environment = environment(&[("DEVBOARD_GITEA_URL", "https://explicit.test")]);
    assert_eq!(source_checkout_gitea_url(&configured).await, None);

    let mut not_source = options.clone();
    not_source.source_checkout = Some(false);
    assert_eq!(source_checkout_gitea_url(&not_source).await, None);

    let http_repo = git_repo("source-http", "http://localhost:3000/owner/name.git");
    let mut http = options.clone();
    http.repo_dir = http_repo;
    assert_eq!(source_checkout_gitea_url(&http).await, None);

    let github_repo = git_repo("source-github", "git@github.com:owner/name.git");
    let mut github = options.clone();
    github.repo_dir = github_repo;
    assert_eq!(source_checkout_gitea_url(&github).await, None);
}

// ---------------------------------------------------------------------------
// Labels and titles

#[test]
fn processing_labels_and_titles_normalize_for_duplicate_comparison() {
    assert!(has_processing_label(&[
        "bug".to_string(),
        "processing".to_string()
    ]));
    assert!(!has_processing_label(&["bug".to_string()]));
    assert_eq!(normalize_issue_title("  Fix   Parser \n"), "fix parser");
    assert_eq!(PROCESSING_LABEL, "processing");
    assert_eq!(PROCESSING_LABEL_COLOR, "FBCA04");
    assert_eq!(draft_title("Ready"), "WIP: Ready");
    assert_eq!(draft_title("WIP: Ready"), "WIP: Ready");
    assert_eq!(ready_title("WIP: Ready"), "Ready");
    assert_eq!(ready_title("Ready"), "Ready");
}

// ---------------------------------------------------------------------------
// Composite forge issue client

#[tokio::test]
async fn list_labelled_asks_the_gitea_forge_for_the_label() {
    let labelled = |number: i64, labels: Value| {
        json!({
            "number": number,
            "title": format!("Issue {number}"),
            "html_url": format!("https://gitea.test/owner/name/issues/{number}"),
            "created_at": "2024-01-02T03:04:05Z",
            "state": "open",
            "body": format!("body {number}"),
            "labels": labels,
        })
    };
    let server =
        StubServer::start(
            move |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/repos/owner/name") => json_response(json!({
                    "permissions": {"pull": true, "push": true, "admin": false},
                })),
                ("GET", "/api/v1/user") => json_response(json!({"login": "alice"})),
                ("GET", "/api/v1/repos/owner/name/issues") => {
                    if !request.query.contains("labels=dead-code") {
                        // An unfiltered page means the read walked the whole
                        // history instead of asking the forge for the label.
                        return text_response(500, "unfiltered page");
                    }
                    if request.query.contains("page=1") {
                        // A forge that honours the filter answers with the match
                        // alone, in one page of the whole 1,397-issue history.
                        json_response(json!([labelled(7, json!([{"name": "dead-code"}]))]))
                    } else {
                        json_response(json!([]))
                    }
                }
                _ => text_response(500, "unexpected"),
            },
        )
        .await;
    let repo = git_repo("list-labelled", "git@localhost:owner/name.git");
    let client = ForgeIssuesClient::new(ForgeIssuesOptions {
        repo_dir: repo,
        environment: environment(&[
            ("DEVBOARD_GITEA_URL", server.base.as_str()),
            ("GITEA_TOKEN", "secret"),
        ]),
        transport: Some(default_transport(5_000)),
        exec: None,
        run: None,
        timeout_ms: Some(5_000),
    })
    .expect("client");

    let documents = client
        .list_labelled(IssueQueryState::All, "dead-code")
        .await
        .expect("a labelled read");
    assert_eq!(documents.len(), 1);
    assert_eq!(documents[0].number, 7);
    assert_eq!(documents[0].body, "body 7");
    assert_eq!(documents[0].labels, vec!["dead-code".to_string()]);
    // The label filter runs on the forge and the listed row carries the body, so
    // the read never walks the whole history and never reads an issue back.
    let listed: Vec<RecordedRequest> = server
        .requests()
        .into_iter()
        .filter(|request| request.path == "/api/v1/repos/owner/name/issues")
        .collect();
    assert_eq!(
        listed.len(),
        2,
        "the labelled page and the page that ends it"
    );
    for request in &listed {
        assert!(request.query.contains("state=all"), "{}", request.query);
        assert!(
            request.query.contains("labels=dead-code"),
            "{}",
            request.query
        );
    }
    for number in [7, 8, 9] {
        assert!(
            server
                .find("GET", &format!("/api/v1/repos/owner/name/issues/{number}"))
                .is_none(),
            "issue {number} is not read back"
        );
    }
}

#[tokio::test]
async fn the_design_forge_asks_the_gitea_forge_for_the_design_label() {
    let labelled = |number: i64| {
        json!({
            "number": number,
            "title": format!("Issue {number}"),
            "html_url": format!("https://gitea.test/owner/name/issues/{number}"),
            "created_at": "2024-01-02T03:04:05Z",
            "state": "open",
            "body": format!("## Category\n\ncolor {number}\n"),
            "labels": [{"name": "design"}],
        })
    };
    let server =
        StubServer::start(
            move |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/repos/owner/name") => json_response(json!({
                    "permissions": {"pull": true, "push": true, "admin": false},
                })),
                ("GET", "/api/v1/user") => json_response(json!({"login": "alice"})),
                ("GET", "/api/v1/repos/owner/name/issues") => {
                    if !request.query.contains("labels=design") {
                        // An unfiltered page means the periodic read walked the
                        // whole issue history instead of asking for the label.
                        return text_response(500, "unfiltered page");
                    }
                    if request.query.contains("page=1") {
                        json_response(json!([labelled(7)]))
                    } else {
                        json_response(json!([]))
                    }
                }
                _ => text_response(500, "unexpected"),
            },
        )
        .await;
    let repo = git_repo("design-labelled", "git@localhost:owner/name.git");
    let environment = environment(&[
        ("DEVBOARD_GITEA_URL", server.base.as_str()),
        ("GITEA_TOKEN", "secret"),
    ]);
    let forge =
        devboard::workers::design::create_design_forge("owner/name", &repo, &environment, 5_000)
            .expect("a design forge");

    let issues = forge.list_issues().await.expect("a labelled read");
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].number, 7);
    assert_eq!(issues[0].body, "## Category\n\ncolor 7\n");
    let listed: Vec<RecordedRequest> = server
        .requests()
        .into_iter()
        .filter(|request| request.path == "/api/v1/repos/owner/name/issues")
        .collect();
    assert_eq!(
        listed.len(),
        2,
        "the labelled page and the page that ends it"
    );
    for request in &listed {
        assert!(request.query.contains("state=all"), "{}", request.query);
        assert!(request.query.contains("labels=design"), "{}", request.query);
    }
}

#[tokio::test]
async fn list_labelled_keeps_only_labelled_rows_when_the_filter_is_ignored() {
    let labelled = |number: i64, labels: Value| {
        json!({
            "number": number,
            "title": format!("Issue {number}"),
            "html_url": format!("https://gitea.test/owner/name/issues/{number}"),
            "created_at": "2024-01-02T03:04:05Z",
            "state": "open",
            "body": format!("body {number}"),
            "labels": labels,
        })
    };
    let server =
        StubServer::start(
            move |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/repos/owner/name") => json_response(json!({
                    "permissions": {"pull": true, "push": true, "admin": false},
                })),
                ("GET", "/api/v1/user") => json_response(json!({"login": "alice"})),
                ("GET", "/api/v1/repos/owner/name/issues") => {
                    if request.query.contains("page=1") {
                        json_response(json!([
                            labelled(7, json!([{"name": "dead-code"}])),
                            labelled(8, json!([{"name": "scout"}])),
                            labelled(9, json!([])),
                        ]))
                    } else {
                        json_response(json!([]))
                    }
                }
                _ => text_response(500, "unexpected"),
            },
        )
        .await;
    let repo = git_repo("list-labelled-unfiltered", "git@localhost:owner/name.git");
    let client = ForgeIssuesClient::new(ForgeIssuesOptions {
        repo_dir: repo,
        environment: environment(&[
            ("DEVBOARD_GITEA_URL", server.base.as_str()),
            ("GITEA_TOKEN", "secret"),
        ]),
        transport: Some(default_transport(5_000)),
        exec: None,
        run: None,
        timeout_ms: Some(5_000),
    })
    .expect("client");

    let documents = client
        .list_labelled(IssueQueryState::All, "dead-code")
        .await
        .expect("a labelled read");
    assert_eq!(documents.len(), 1);
    assert_eq!(documents[0].number, 7);
    assert_eq!(documents[0].body, "body 7");
    assert!(server
        .find("GET", "/api/v1/repos/owner/name/issues/7")
        .is_none());
    assert!(server
        .find("GET", "/api/v1/repos/owner/name/issues/8")
        .is_none());
}

/// The Auto Scout read asks the forge for its own label, so one periodic sync
/// costs one page of matches instead of one page per page of the whole issue
/// history. Under the dashboard's own load the whole-history walk outlived the
/// read deadline and raised the "forge read did not finish" notification.
#[tokio::test]
async fn auto_scout_reads_only_the_scout_labelled_set() {
    let issue = |number: i64, labels: Value| {
        json!({
            "number": number,
            "title": format!("Issue {number}"),
            "html_url": format!("https://gitea.test/owner/name/issues/{number}"),
            "created_at": "2024-01-02T03:04:05Z",
            "state": "open",
            "body": format!("body {number}"),
            "labels": labels,
        })
    };
    let server =
        StubServer::start(
            move |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/repos/owner/name/issues") => {
                    if !request.query.contains("labels=scout") {
                        // Unfiltered means the read walked the whole history.
                        return text_response(500, "unfiltered page");
                    }
                    if request.query.contains("page=1") {
                        json_response(json!([
                            issue(7, json!([{"name": "scout"}])),
                            issue(8, json!([{"name": "dead-code"}])),
                        ]))
                    } else {
                        json_response(json!([]))
                    }
                }
                _ => text_response(500, "unexpected"),
            },
        )
        .await;
    let forge = GiteaScoutForge::new(
        GiteaTarget {
            base_url: server.base.clone(),
            project: "owner/name".to_string(),
            token: Some("secret".to_string()),
        },
        git_repo("scout-labelled-read", "git@localhost:owner/name.git"),
        5_000,
    );

    let read = forge.list_issues().await.expect("a scout read");
    assert_eq!(read.len(), 1);
    assert_eq!(read[0].number, 7);
    let listed: Vec<RecordedRequest> = server
        .requests()
        .into_iter()
        .filter(|request| request.path == "/api/v1/repos/owner/name/issues")
        .collect();
    assert_eq!(
        listed.len(),
        2,
        "the labelled page and the page that ends it"
    );
    for request in &listed {
        assert!(request.query.contains("state=all"), "{}", request.query);
        assert!(request.query.contains("labels=scout"), "{}", request.query);
    }
}

#[tokio::test]
async fn forge_issue_client_reads_closes_and_caches_its_credential() {
    let server =
        StubServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/repos/owner/name") => json_response(json!({
                    "permissions": {"pull": true, "push": true, "admin": false},
                })),
                ("GET", "/api/v1/user") => json_response(json!({"login": "alice"})),
                ("GET", "/api/v1/repos/owner/name/issues") => {
                    if request.query.contains("page=1") {
                        json_response(json!([issue_value(7, "Seven", "open")]))
                    } else {
                        json_response(json!([]))
                    }
                }
                ("GET", "/api/v1/repos/owner/name/issues/7") => {
                    json_response(issue_value(7, "Seven", "closed"))
                }
                ("PATCH", "/api/v1/repos/owner/name/issues/7") => json_response(json!({})),
                _ => text_response(500, "unexpected"),
            },
        )
        .await;
    let repo = git_repo("issues-client", "git@localhost:owner/name.git");
    let client = ForgeIssuesClient::new(ForgeIssuesOptions {
        repo_dir: repo,
        environment: environment(&[
            ("DEVBOARD_GITEA_URL", server.base.as_str()),
            ("GITEA_TOKEN", "secret"),
        ]),
        transport: Some(default_transport(5_000)),
        exec: None,
        run: None,
        timeout_ms: Some(5_000),
    })
    .expect("client");
    assert_eq!(client.forge(), Forge::Gitea);
    assert_eq!(client.repository(), "owner/name");

    let open = client
        .list(IssueQueryState::Open, None)
        .await
        .expect("list");
    assert_eq!(open.len(), 1);
    assert_eq!(open[0].number, 7);
    let requests = server.requests();
    assert_eq!(requests[0].path, "/api/v1/repos/owner/name");
    assert_eq!(requests[1].path, "/api/v1/user");
    assert_eq!(requests[2].path, "/api/v1/repos/owner/name/issues");
    assert_eq!(
        requests[2].headers.get("authorization").map(String::as_str),
        Some("token secret")
    );

    let closed = client
        .close(7, CloseReason::NotPlanned)
        .await
        .expect("close");
    assert_eq!(closed.state, IssueState::Closed);
    // The credential is resolved once per access level: read probes twice
    // (repository and user), and the write access probes twice again.
    assert_eq!(server.count(), 8);
    let patch = server
        .find("PATCH", "/api/v1/repos/owner/name/issues/7")
        .expect("close request");
    assert_eq!(
        String::from_utf8(patch.body).expect("utf8"),
        r#"{"state":"closed"}"#
    );
}

#[tokio::test]
async fn a_refused_credential_never_blocks_a_public_read_and_never_retries_a_write() {
    let server = StubServer::start(|request| {
        if request.path.ends_with("/issues") && request.headers.contains_key("authorization") {
            return text_response(401, r#"{"message":"invalid username, password or token"}"#);
        }
        if request.path.ends_with("/issues/7") && request.method == "PATCH" {
            return text_response(401, r#"{"message":"invalid username, password or token"}"#);
        }
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/api/v1/repos/owner/name") => json_response(json!({
                "permissions": {"pull": true, "push": true, "admin": false},
            })),
            ("GET", "/api/v1/user") => json_response(json!({"login": "alice"})),
            ("GET", "/api/v1/repos/owner/name/issues") => {
                if request.query.contains("page=1") {
                    json_response(json!([issue_value(7, "Seven", "open")]))
                } else {
                    json_response(json!([]))
                }
            }
            _ => text_response(500, "unexpected"),
        }
    })
    .await;
    let repo = git_repo("issues-client-refusal", "git@localhost:owner/name.git");
    let client = ForgeIssuesClient::new(ForgeIssuesOptions {
        repo_dir: repo,
        environment: environment(&[
            ("DEVBOARD_GITEA_URL", server.base.as_str()),
            ("GITEA_TOKEN", "secret"),
        ]),
        transport: Some(default_transport(5_000)),
        exec: None,
        run: None,
        timeout_ms: Some(5_000),
    })
    .expect("client");

    // The credential was accepted when this client resolved it, and the forge
    // refuses it for every later read, as a rotated token is refused.
    let open = client
        .list(IssueQueryState::Open, None)
        .await
        .expect("list");
    assert_eq!(open.len(), 1);
    assert_eq!(open[0].number, 7);
    let list_requests: Vec<RecordedRequest> = server
        .requests()
        .into_iter()
        .filter(|request| request.path.ends_with("/issues"))
        .filter(|request| request.query.contains("page=1"))
        .collect();
    assert_eq!(
        list_requests.len(),
        2,
        "one refused read, one anonymous read"
    );
    assert_eq!(
        list_requests[0]
            .headers
            .get("authorization")
            .map(String::as_str),
        Some("token secret")
    );
    assert!(!list_requests[1].headers.contains_key("authorization"));

    // A write has no anonymous form: the refused credential is reported, and
    // the request is never repeated without it.
    let refused = client
        .close(7, CloseReason::NotPlanned)
        .await
        .expect_err("a refused write");
    assert!(refused
        .message
        .contains("invalid username, password or token"));
    assert_eq!(
        server
            .requests()
            .iter()
            .filter(|request| request.method == "PATCH")
            .count(),
        1
    );
}

#[tokio::test]
async fn a_refused_account_probe_never_blocks_a_public_list() {
    let server =
        StubServer::start(
            |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/repos/owner/name") => json_response(json!({
                    "permissions": {"pull": true, "push": false, "admin": false},
                })),
                // The token the repository view accepted is refused when the
                // client asks who it belongs to. The read must still answer, as
                // a Watchdog deduplication turn lists this repository.
                ("GET", "/api/v1/user") => {
                    text_response(401, r#"{"message":"invalid username, password or token"}"#)
                }
                ("GET", "/api/v1/repos/owner/name/issues") => {
                    if request.query.contains("page=1") {
                        json_response(json!([issue_value(7, "Seven", "open")]))
                    } else {
                        json_response(json!([]))
                    }
                }
                _ => text_response(500, "unexpected"),
            },
        )
        .await;
    let repo = git_repo(
        "issues-client-refused-account",
        "git@localhost:owner/name.git",
    );
    let client = ForgeIssuesClient::new(ForgeIssuesOptions {
        repo_dir: repo,
        environment: environment(&[
            ("DEVBOARD_GITEA_URL", server.base.as_str()),
            ("GITEA_TOKEN", "secret"),
        ]),
        transport: Some(default_transport(5_000)),
        exec: None,
        run: None,
        timeout_ms: Some(5_000),
    })
    .expect("client");

    let open = client
        .list(IssueQueryState::Open, None)
        .await
        .expect("the public read answers");
    assert_eq!(open.len(), 1);
    assert_eq!(open[0].number, 7);
    let list_requests: Vec<RecordedRequest> = server
        .requests()
        .into_iter()
        .filter(|request| request.path.ends_with("/issues"))
        .filter(|request| request.query.contains("page=1"))
        .collect();
    assert_eq!(
        list_requests.len(),
        1,
        "one anonymous read, no refused retry"
    );
    assert!(!list_requests[0].headers.contains_key("authorization"));
}

#[tokio::test]
async fn a_read_that_needs_the_refused_credential_reports_the_refusal() {
    let server = StubServer::start(|request| {
        if request.path.ends_with("/issues") {
            return text_response(401, r#"{"message":"invalid username, password or token"}"#);
        }
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/api/v1/repos/owner/name") => json_response(json!({
                "permissions": {"pull": true, "push": true, "admin": false},
            })),
            ("GET", "/api/v1/user") => json_response(json!({"login": "alice"})),
            _ => text_response(500, "unexpected"),
        }
    })
    .await;
    let repo = git_repo("issues-client-private", "git@localhost:owner/name.git");
    let client = ForgeIssuesClient::new(ForgeIssuesOptions {
        repo_dir: repo,
        environment: environment(&[
            ("DEVBOARD_GITEA_URL", server.base.as_str()),
            ("GITEA_TOKEN", "secret"),
        ]),
        transport: Some(default_transport(5_000)),
        exec: None,
        run: None,
        timeout_ms: Some(5_000),
    })
    .expect("client");

    let error = client
        .list(IssueQueryState::Open, None)
        .await
        .expect_err("a private repository needs the credential");
    assert!(error.message.contains("HTTP 401"), "{}", error.message);
    assert!(
        error
            .message
            .contains("invalid username, password or token"),
        "{}",
        error.message
    );
    // The refusal is retried anonymously once, and the second refusal is what
    // the caller sees; there is no third attempt.
    assert_eq!(
        server
            .requests()
            .iter()
            .filter(|request| request.path.ends_with("/issues"))
            .filter(|request| request.query.contains("page=1"))
            .count(),
        2
    );
}

#[tokio::test]
async fn a_failed_credential_probe_is_not_remembered() {
    let probes = Arc::new(AtomicUsize::new(0));
    let counted = probes.clone();
    let server =
        StubServer::start(
            move |request| match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api/v1/repos/owner/name") => {
                    if counted.fetch_add(1, Ordering::SeqCst) == 0 {
                        return text_response(500, "the forge is restarting");
                    }
                    json_response(json!({
                        "permissions": {"pull": true, "push": true, "admin": false},
                    }))
                }
                ("GET", "/api/v1/user") => json_response(json!({"login": "alice"})),
                ("GET", "/api/v1/repos/owner/name/issues") => json_response(json!([])),
                _ => text_response(500, "unexpected"),
            },
        )
        .await;
    let repo = git_repo("issues-client-recovery", "git@localhost:owner/name.git");
    let client = ForgeIssuesClient::new(ForgeIssuesOptions {
        repo_dir: repo,
        environment: environment(&[
            ("DEVBOARD_GITEA_URL", server.base.as_str()),
            ("GITEA_TOKEN", "secret"),
        ]),
        transport: Some(default_transport(5_000)),
        exec: None,
        run: None,
        timeout_ms: Some(5_000),
    })
    .expect("client");

    // One forge that cannot answer must not keep the client blind for its
    // lifetime: the failed probe is not remembered, so the next read resolves
    // the credential again and succeeds.
    let error = client
        .list(IssueQueryState::Open, None)
        .await
        .expect_err("a forge that cannot answer");
    assert!(error.message.contains("HTTP 500"), "{}", error.message);
    let open = client
        .list(IssueQueryState::Open, None)
        .await
        .expect("the next read resolves again");
    assert!(open.is_empty());
    assert_eq!(probes.load(Ordering::SeqCst), 2, "two repository probes");
}

// ---------------------------------------------------------------------------
// Shipped resolution against a real checkout

fn git_in(repo: &std::path::Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-c")
        .arg("user.name=Forge Fixture")
        .arg("-c")
        .arg("user.email=fixture@example.test")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {} failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr).trim()
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn commit_naming(repo: &std::path::Path, message: &str) -> String {
    std::fs::write(repo.join("file.txt"), message.as_bytes()).unwrap();
    git_in(repo, &["add", "file.txt"]);
    git_in(repo, &["commit", "-q", "-m", message]);
    git_in(repo, &["rev-parse", "HEAD"])
}

#[tokio::test]
async fn a_non_release_tag_and_an_unlanded_commit_never_settle_an_issue() {
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("forge-shipped-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&repo);
    std::fs::create_dir_all(&repo).unwrap();
    git_in(&repo, &["init", "-q"]);
    let released = commit_naming(&repo, "feat: first");
    git_in(&repo, &["tag", "v1.0.0"]);
    let candidate = commit_naming(&repo, "feat: candidate");
    git_in(&repo, &["tag", "v1.5.0-rc.1"]);
    // A merge commit keeps the released tag reachable from HEAD.
    git_in(&repo, &["merge", "-q", "--no-ff", "-m", "merge", &released]);
    let landed = commit_naming(&repo, "fix: the issue (#2)");

    let client = RepositoryGitHub::new(RepositoryGitHubOptions {
        repository: "acme/fixture".to_string(),
        repo_dir: repo.clone(),
        run: Arc::new(|_argv, _environment| {
            Box::pin(async { panic!("a local containment read never asks gh") })
        }),
        environment: Environment::new(),
    });
    let releases = vec![GitHubRelease {
        tag: "v1.0.0".to_string(),
        published_at: "2024-01-01T00:00:00Z".to_string(),
    }];
    assert!(
        client.landed_commits(2).contains(&landed),
        "the landed commit is read from HEAD"
    );
    let contained = client
        .containing_release_tags(&landed, &releases)
        .await
        .expect("a local containment read");
    assert!(
        contained.is_empty(),
        "only the published release tag counts, not the rc tag: {contained:?}"
    );
    let unlanded = client
        .containing_release_tags(&candidate, &releases)
        .await
        .expect("a local containment read");
    assert!(
        unlanded.is_empty(),
        "a commit outside every published release never settles: {unlanded:?}"
    );
    let _ = std::fs::remove_dir_all(&repo);
}

// ---------------------------------------------------------------------------
// The origin as the tracker source

#[test]
fn an_origin_that_names_no_forge_explains_itself() {
    let root = temp_dir("no-origin-checkout");
    let status = Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["init", "-q"])
        .status()
        .expect("git init");
    assert!(status.success());
    let env = environment(&[]);

    assert!(origin_forge_with(&root, &env).is_none());
    let problem = origin_problem(&root, &env).expect("a problem");
    assert!(
        problem.contains("has no `origin` remote"),
        "the origin is the reason: {problem}"
    );

    let source = TrackerSource::resolve(&root, &env);
    assert!(source.remote.is_none());
    let operation = source.operation(OPEN_ISSUES_READ);
    assert!(
        operation.contains("the checkout's origin does not name a supported forge"),
        "{operation}"
    );
    assert!(operation.contains("has no `origin` remote"), "{operation}");

    let refused = source.poll_result(
        OPEN_ISSUES_READ,
        PollResult::Error {
            detail: "connection refused".to_string(),
        },
    );
    match refused {
        PollResult::Error { detail } => {
            assert_eq!(
                detail, operation,
                "an unresolved origin names the origin, not a forge read"
            );
        }
        other => panic!("expected an error, got {other:?}"),
    }

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn an_unparsable_origin_names_the_remote() {
    let repo = git_repo("unparsable-origin", "file:///srv/git/owner/name.git");
    let env = environment(&[]);

    assert!(origin_forge_with(&repo, &env).is_none());
    let problem = origin_problem(&repo, &env).expect("a problem");
    assert!(
        problem.contains("does not name a supported forge repository"),
        "{problem}"
    );
    assert!(
        problem.contains("file:///srv/git/owner/name.git"),
        "{problem}"
    );

    let _ = std::fs::remove_dir_all(&repo);
}

#[test]
fn a_tracker_source_names_the_forge_and_operation() {
    let repo = git_repo("gitea-source", "ssh://git@localhost:2223/owner/name.git");
    let env = environment(&[]);
    let source = TrackerSource::resolve(&repo, &env);
    assert_eq!(
        source.operation(OPEN_ISSUES_READ),
        "Gitea open-issue read for owner/name"
    );
    assert_eq!(
        source.failure(OPEN_ISSUES_READ, "the connection was refused"),
        "Gitea open-issue read for owner/name failed: the connection was refused"
    );
    assert_eq!(
        source.deadline(OPEN_ISSUES_READ, 20_000),
        "Gitea open-issue read for owner/name: the tracker did not answer within 20000 ms"
    );

    let named = source.poll_result(
        OPEN_ISSUES_READ,
        PollResult::Error {
            detail: "the connection was refused".to_string(),
        },
    );
    assert_eq!(
        named,
        PollResult::Error {
            detail: "Gitea open-issue read for owner/name failed: the connection was refused"
                .to_string(),
        }
    );
    let unchanged = PollResult::NotModified { etag: None };
    assert_eq!(
        source.poll_result(OPEN_ISSUES_READ, unchanged.clone()),
        unchanged
    );

    let _ = std::fs::remove_dir_all(&repo);
}

#[tokio::test]
async fn a_refused_gitea_connection_names_the_cause() {
    // A loopback port that was just released refuses the connection, so the
    // transport's own cause chain decides the sentence.
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("a free port");
    let port = listener.local_addr().expect("an address").port();
    drop(listener);
    let options = TrackerOptions {
        forge: Forge::Gitea,
        repository: "owner/name".to_string(),
        etag: None,
        run: None,
        environment: environment(&[("GITEA_TOKEN", "secret")]),
        timeout_ms: Some(2_000),
        base_url: Some(format!("http://127.0.0.1:{port}")),
        transport: Some(default_transport(2_000)),
    };

    match poll_open_issues(&options).await {
        PollResult::Error { detail } => {
            assert!(
                detail.contains("/api/v1/repos/owner/name/issues"),
                "the request is named: {detail}"
            );
            assert!(
                detail.to_lowercase().contains("connection refused"),
                "the cause is named: {detail}"
            );
        }
        other => panic!("expected an error, got {other:?}"),
    }
}
