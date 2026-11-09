//! The HTTP surface table: every path, method, and status family the contract
//! names, exercised against a private in-process listener.

use std::path::{Path, PathBuf};

use devboard::config::Config;
use devboard::http::Server;
use devboard::journal::Journal;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT_ENCODING, HOST, ORIGIN};
use reqwest::{Method, StatusCode};

struct Instance {
    base: String,
    root: PathBuf,
    server: std::sync::Arc<Server>,
}

fn private_root(label: &str) -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("http-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("repo/adrs")).expect("a fixture root");
    std::fs::create_dir_all(root.join("state")).expect("a fixture state");
    std::fs::create_dir_all(root.join("static/assets")).expect("a fixture static root");
    std::fs::write(
        root.join("static/index.html"),
        "<!doctype html><title>t</title>\n",
    )
    .expect("an index document");
    std::fs::write(root.join("static/assets/app-abc.css"), "body{}\n").expect("an asset");
    root
}

async fn start(label: &str) -> Instance {
    let root = private_root(label);
    let config = Config {
        hostname: "127.0.0.1".to_string(),
        port: 0,
        adrs_dir: root.join("repo/adrs"),
        repo_dir: root.join("repo"),
        goal_file: root.join("repo/GOAL.md"),
        static_dir: Some(root.join("static")),
        agent_command: "true".to_string(),
        state_dir: root.join("state"),
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
    let handle = std::sync::Arc::clone(&server);
    tokio::spawn(async move {
        let _ = devboard::http::serve_on(listener, server).await;
    });
    Instance {
        base: format!("http://127.0.0.1:{port}"),
        root,
        server: handle,
    }
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_gzip()
        .build()
        .expect("a client")
}

/// Sends one raw request line, so percent-encoded dot segments reach the
/// server exactly as written.
async fn raw_get(base: &str, path: &str) -> u16 {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let address = base.trim_start_matches("http://");
    let mut stream = tokio::net::TcpStream::connect(address)
        .await
        .expect("a connection");
    let request = format!("GET {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .expect("a request");
    let mut response = Vec::new();
    let _ = stream.read_to_end(&mut response).await;
    let text = String::from_utf8_lossy(&response);
    text.split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0)
}

async fn send(method: Method, url: &str, headers: HeaderMap) -> (StatusCode, HeaderMap, Vec<u8>) {
    let response = client()
        .request(method, url)
        .headers(headers)
        .send()
        .await
        .expect("an answer");
    let status = response.status();
    let headers = response.headers().clone();
    let body = response.bytes().await.expect("a body").to_vec();
    (status, headers, body)
}

#[tokio::test]
async fn ready_answers_get_and_head_with_the_pid() {
    let instance = start("ready").await;
    let (status, headers, body) = send(
        Method::GET,
        &format!("{}/ready", instance.base),
        HeaderMap::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers
            .get("cache-control")
            .and_then(|value| value.to_str().ok()),
        Some("no-store")
    );
    let parsed: serde_json::Value = serde_json::from_slice(&body).expect("JSON");
    assert_eq!(parsed["pid"], std::process::id());

    let (status, headers, body) = send(
        Method::HEAD,
        &format!("{}/ready", instance.base),
        HeaderMap::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers
            .get("cache-control")
            .and_then(|value| value.to_str().ok()),
        Some("no-store")
    );
    assert!(body.is_empty(), "HEAD carries no body");
}

#[tokio::test]
async fn ready_refuses_other_methods_with_allow() {
    let instance = start("ready-method").await;
    for method in [Method::POST, Method::PUT, Method::DELETE] {
        let (status, headers, body) = send(
            method.clone(),
            &format!("{}/ready", instance.base),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED, "{method}");
        assert_eq!(
            headers.get("allow").and_then(|value| value.to_str().ok()),
            Some("GET, HEAD")
        );
        let parsed: serde_json::Value = serde_json::from_slice(&body).expect("problem JSON");
        assert_eq!(parsed["status"], 405);
        assert_eq!(parsed["title"], "Method Not Allowed");
    }
}

#[tokio::test]
async fn ready_negotiates_gzip() {
    let instance = start("ready-gzip").await;
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("gzip"));
    let (status, headers, _body) =
        send(Method::GET, &format!("{}/ready", instance.base), headers).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers
            .get("content-encoding")
            .and_then(|value| value.to_str().ok()),
        Some("gzip")
    );
    assert_eq!(
        headers.get("vary").and_then(|value| value.to_str().ok()),
        Some("Accept-Encoding")
    );
}

#[tokio::test]
async fn the_retired_socket_path_answers_not_found() {
    let instance = start("ws-gone").await;
    let url = format!("{}/ws", instance.base);
    for method in [Method::GET, Method::POST] {
        let (status, headers, body) = send(method, &url, HeaderMap::new()).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(
            headers
                .get("content-type")
                .and_then(|value| value.to_str().ok()),
            Some("application/problem+json")
        );
        let parsed: serde_json::Value = serde_json::from_slice(&body).expect("problem JSON");
        assert_eq!(parsed["status"], 404);
    }
    let mut headers = HeaderMap::new();
    headers.insert(HOST, HeaderValue::from_static("evil.test"));
    let (status, _headers, _body) = send(Method::GET, &url, headers).await;
    assert_eq!(status, StatusCode::MISDIRECTED_REQUEST);
    let mut headers = HeaderMap::new();
    headers.insert(ORIGIN, HeaderValue::from_static("http://evil.test"));
    let (status, _headers, _body) = send(Method::GET, &url, headers).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn static_serving_refuses_control_characters_and_normalizes_paths() {
    let instance = start("static-guards").await;
    let (status, _headers, _body) = send(
        Method::GET,
        &format!("{}/%00index.html", instance.base),
        HeaderMap::new(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    for path in ["/..%2findex.html", "/%2e%2e/index.html"] {
        let status = raw_get(&instance.base, path).await;
        assert_eq!(status, 404, "{path}");
    }
    for path in ["/assets/", "/missing.txt", "/assets/app-abc.css/"] {
        let (status, _headers, _body) = send(
            Method::GET,
            &format!("{}{path}", instance.base),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
    }

    let (status, headers, body) = send(
        Method::GET,
        &format!("{}/", instance.base),
        HeaderMap::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers
            .get("cache-control")
            .and_then(|value| value.to_str().ok()),
        Some("no-cache")
    );
    assert!(
        headers.get("set-cookie").is_none(),
        "the document sets no cookie"
    );
    assert!(
        headers.get("www-authenticate").is_none(),
        "the document demands no credential"
    );
    assert!(String::from_utf8_lossy(&body).contains("<!doctype html"));

    let (status, headers, _body) = send(
        Method::GET,
        &format!("{}/assets/app-abc.css", instance.base),
        HeaderMap::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers
            .get("cache-control")
            .and_then(|value| value.to_str().ok()),
        Some("public, max-age=31536000, immutable")
    );
}

#[tokio::test]
async fn an_unserved_operation_path_names_the_request_it_refuses() {
    let instance = start("rest-unserved").await;
    for path in ["/issues/runs/", "/flows/unknown", "/agents//prompt"] {
        let (status, headers, body) = send(
            Method::GET,
            &format!("{}{path}", instance.base),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
        assert_eq!(
            headers
                .get("content-type")
                .and_then(|value| value.to_str().ok()),
            Some("application/problem+json"),
            "{path}"
        );
        let parsed: serde_json::Value = serde_json::from_slice(&body).expect("problem JSON");
        assert_eq!(
            parsed["detail"],
            format!("This server serves no GET {path}."),
            "{path}"
        );
    }

    let (status, _headers, body) = send(
        Method::GET,
        &format!("{}/missing.txt", instance.base),
        HeaderMap::new(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let parsed: serde_json::Value = serde_json::from_slice(&body).expect("problem JSON");
    assert_eq!(
        parsed["detail"], "The requested file was not found.",
        "a static miss keeps its own detail"
    );
}

#[tokio::test]
async fn mutating_endpoints_enforce_method_and_configuration() {
    let instance = start("endpoints").await;
    let (status, _headers, _body) = send(
        Method::POST,
        &format!("{}/reports", instance.base),
        HeaderMap::new(),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::SERVICE_UNAVAILABLE,
        "reporting without a Gitea target is disabled, never unauthorized"
    );
    let (status, _headers, body) = send(
        Method::POST,
        &format!("{}/goal-proposals", instance.base),
        HeaderMap::new(),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "the handler answers the empty report, never 401"
    );
    let parsed: serde_json::Value = serde_json::from_slice(&body).expect("problem JSON");
    assert_eq!(parsed["title"], "Bad Request");

    let (status, headers, _body) = send(
        Method::GET,
        &format!("{}/reports", instance.base),
        HeaderMap::new(),
    )
    .await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(
        headers.get("allow").and_then(|value| value.to_str().ok()),
        Some("POST")
    );

    let (status, _headers, body) = send(
        Method::POST,
        &format!("{}/reports", instance.base),
        HeaderMap::new(),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    let parsed: serde_json::Value = serde_json::from_slice(&body).expect("problem JSON");
    assert!(parsed["detail"]
        .as_str()
        .expect("detail")
        .contains("DEVBOARD_GITEA_URL"));

    let (status, _headers, _body) = send(
        Method::GET,
        &format!("{}/goal-proposals", instance.base),
        HeaderMap::new(),
    )
    .await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
}

#[tokio::test]
async fn unknown_paths_answer_problem_json() {
    let instance = start("unknown").await;
    let (status, headers, body) = send(
        Method::GET,
        &format!("{}/nope", instance.base),
        HeaderMap::new(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        headers
            .get("content-type")
            .and_then(|value| value.to_str().ok()),
        Some("application/problem+json")
    );
    let parsed: serde_json::Value = serde_json::from_slice(&body).expect("problem JSON");
    assert_eq!(parsed["type"], "about:blank");
    assert_eq!(parsed["title"], "Not Found");
}

#[tokio::test]
async fn a_malformed_flow_id_is_refused_before_the_handler() {
    let instance = start("flow-id").await;
    let mut headers = HeaderMap::new();
    headers.insert("x-flow-id", HeaderValue::from_static("bad id"));
    let (status, _headers, body) =
        send(Method::GET, &format!("{}/ready", instance.base), headers).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let parsed: serde_json::Value = serde_json::from_slice(&body).expect("problem JSON");
    assert_eq!(parsed["detail"], "X-Flow-ID must be a printable token.");
}

#[tokio::test]
async fn the_rest_api_answers_a_recorded_read() {
    let instance = start("rest-read").await;
    let (status, _headers, body) = send(
        Method::GET,
        &format!("{}/project", instance.base),
        HeaderMap::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let parsed: serde_json::Value = serde_json::from_slice(&body).expect("JSON");
    let frames = parsed["frames"].as_array().expect("frames");
    assert_eq!(frames[0]["type"], "project");
    let path = frames[0]["path"].as_str().expect("a path");
    assert!(!Path::new(path).is_absolute() || path == instance.root.to_string_lossy());

    let (status, headers, body) = send(
        Method::POST,
        &format!("{}/project", instance.base),
        HeaderMap::new(),
    )
    .await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(
        headers.get("allow").and_then(|value| value.to_str().ok()),
        Some("GET, HEAD")
    );
    let parsed: serde_json::Value = serde_json::from_slice(&body).expect("problem JSON");
    assert_eq!(parsed["status"], 405);
}

#[tokio::test]
async fn the_embedded_client_serves_without_a_static_directory() {
    let root = private_root("embedded");
    let config = Config {
        hostname: "127.0.0.1".to_string(),
        port: 0,
        adrs_dir: root.join("repo/adrs"),
        repo_dir: root.join("repo"),
        goal_file: root.join("repo/GOAL.md"),
        static_dir: None,
        agent_command: "true".to_string(),
        state_dir: root.join("state"),
        allowed_hosts: Vec::new(),
        feedback: None,
    };
    let listener = devboard::http::bind("127.0.0.1", 0)
        .await
        .expect("a listener");
    let port = listener.local_addr().expect("an address").port();
    let mut config = config;
    config.port = port;
    let journal = Journal::open(&config.state_dir, &config.repo_dir, port);
    let server = Server::new(config, journal);
    tokio::spawn(async move {
        let _ = devboard::http::serve_on(listener, server).await;
    });
    let base = format!("http://127.0.0.1:{port}");
    let (status, headers, body) = send(Method::GET, &format!("{base}/"), HeaderMap::new()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers
            .get("content-type")
            .and_then(|value| value.to_str().ok()),
        Some("text/html;charset=utf-8")
    );
    assert!(
        headers.get("set-cookie").is_none(),
        "an embedded document sets no cookie"
    );
    assert!(String::from_utf8_lossy(&body).contains("<html"));
    let (status, _headers, _body) = send(
        Method::GET,
        &format!("{base}/assets/does-not-exist.js"),
        HeaderMap::new(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_flow_id_is_echoed_on_endpoint_answers_and_never_on_a_static_asset() {
    let instance = start("flow-echo").await;

    let mut headers = HeaderMap::new();
    headers.insert("x-flow-id", HeaderValue::from_static("flow-42"));
    let (_status, headers, _body) =
        send(Method::GET, &format!("{}/ready", instance.base), headers).await;
    assert_eq!(
        headers
            .get("x-flow-id")
            .and_then(|value| value.to_str().ok()),
        Some("flow-42")
    );

    let mut headers = HeaderMap::new();
    headers.insert("x-flow-id", HeaderValue::from_static("flow-42"));
    let (status, headers, _body) = send(
        Method::GET,
        &format!("{}/assets/app-abc.css", instance.base),
        headers,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        headers.get("x-flow-id").is_none(),
        "a shared cache must not replay one client's flow id"
    );

    let mut headers = HeaderMap::new();
    headers.insert("x-flow-id", HeaderValue::from_static("flow-42"));
    headers.insert(HOST, HeaderValue::from_static("evil.test"));
    let (status, headers, _body) =
        send(Method::GET, &format!("{}/records", instance.base), headers).await;
    assert_eq!(status, StatusCode::MISDIRECTED_REQUEST);
    assert_eq!(
        headers
            .get("x-flow-id")
            .and_then(|value| value.to_str().ok()),
        Some("flow-42")
    );
}

#[tokio::test]
async fn mutating_endpoints_refuse_a_misdirected_host() {
    let instance = start("endpoint-host").await;
    for (method, path, expected) in [
        (Method::POST, "/reports", StatusCode::MISDIRECTED_REQUEST),
        (Method::POST, "/goal-proposals", StatusCode::FORBIDDEN),
        (
            Method::GET,
            "/goal-proposals/missing.md",
            StatusCode::FORBIDDEN,
        ),
        (Method::GET, "/records", StatusCode::MISDIRECTED_REQUEST),
    ] {
        let mut headers = HeaderMap::new();
        headers.insert(HOST, HeaderValue::from_static("evil.test"));
        let (status, _headers, body) =
            send(method, &format!("{}{path}", instance.base), headers).await;
        assert_eq!(status, expected, "{path}");
        let parsed: serde_json::Value = serde_json::from_slice(&body).expect("problem JSON");
        assert!(parsed["title"].is_string());
        assert_eq!(
            parsed["detail"],
            "The request host is not served by this dashboard."
        );
    }
    let mut headers = HeaderMap::new();
    headers.insert(HOST, HeaderValue::from_static("evil.test"));
    let (status, _headers, _body) =
        send(Method::GET, &format!("{}/ws", instance.base), headers).await;
    assert_eq!(status, StatusCode::MISDIRECTED_REQUEST);
}

#[tokio::test]
async fn an_unreadable_static_file_answers_500_and_journals() {
    let instance = start("static-unreadable").await;
    // The running server reads its immutable snapshot, never the source
    // bundle; the unreadable file therefore belongs in the snapshot.
    let serving = instance.root.join("state").join("serving");
    let snapshot = std::fs::read_dir(&serving)
        .expect("the serving directory")
        .filter_map(Result::ok)
        .find(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .expect("a snapshot")
        .path();
    let path = snapshot.join("assets/secret.txt");
    std::fs::write(&path, "secret\n").expect("a file");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000))
            .expect("an unreadable file");
    }
    let (status, _headers, body) = send(
        Method::GET,
        &format!("{}/assets/secret.txt", instance.base),
        HeaderMap::new(),
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    let parsed: serde_json::Value = serde_json::from_slice(&body).expect("problem JSON");
    assert_eq!(parsed["title"], "Internal Server Error");
    assert_eq!(parsed["detail"], "An internal error occurred.");
    let journal = std::fs::read_to_string(
        instance
            .root
            .join("state")
            .join("journal")
            .join(format!("{}.jsonl", "0".repeat(24))),
    )
    .or_else(|_| {
        let directory = instance.root.join("state").join("journal");
        let entry = std::fs::read_dir(directory)
            .expect("the journal directory")
            .filter_map(Result::ok)
            .max_by_key(|entry| entry.file_name())
            .expect("a journal file");
        std::fs::read_to_string(entry.path())
    })
    .expect("the journal");
    assert!(journal.contains("server-error"), "{journal}");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644));
    }
}

#[tokio::test]
async fn a_static_directory_is_served_from_an_immutable_snapshot() {
    let instance = start("static-snapshot").await;
    let (status, _, first) = send(
        Method::GET,
        &format!("{}/", instance.base),
        HeaderMap::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let serving = instance.root.join("state").join("serving");
    let snapshot = std::fs::read_dir(&serving)
        .expect("the serving directory")
        .filter_map(Result::ok)
        .find(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .expect("a snapshot")
        .path();
    let name = snapshot
        .file_name()
        .and_then(|name| name.to_str())
        .expect("a snapshot name");
    assert!(
        name.starts_with(&std::process::id().to_string()),
        "{name} names the running pid"
    );
    std::fs::write(
        instance.root.join("static/index.html"),
        "<!doctype html><title>replaced</title>\n",
    )
    .expect("a replaced bundle");
    let (status, _, second) = send(
        Method::GET,
        &format!("{}/", instance.base),
        HeaderMap::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first, second, "a rebuild never changes the served bytes");
}

#[tokio::test]
async fn the_readiness_probe_answers_without_a_credential_and_checks_the_pid() {
    let instance = start("ready-probe").await;
    let port: u16 = instance
        .base
        .rsplit(':')
        .next()
        .and_then(|value| value.parse().ok())
        .expect("the listener port");
    assert!(devboard::relaunch::probe_ready(port, Some(std::process::id())).await);
    assert!(!devboard::relaunch::probe_ready(port, Some(0)).await);
}

#[tokio::test]
async fn a_starting_frame_arrives_while_the_preflight_is_pending() {
    let instance = start("start-frame").await;
    let completed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let release = std::sync::Arc::new(tokio::sync::Notify::new());
    let release_for_preflight = std::sync::Arc::clone(&release);
    let completed_for_preflight = std::sync::Arc::clone(&completed);
    let preflight: devboard::agents_mode::PreflightCallback =
        std::sync::Arc::new(move |_request| {
            let release = std::sync::Arc::clone(&release_for_preflight);
            let completed = std::sync::Arc::clone(&completed_for_preflight);
            Box::pin(async move {
                release.notified().await;
                completed.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok("owner/repository".to_string())
            })
        });
    devboard::agents_mode::set_preflight(&instance.server.app, "dead-code", preflight);
    devboard::agents_mode::set_agent_environment(&instance.server.app, || {
        Box::pin(async { Ok(std::collections::HashMap::new()) })
    });
    devboard::agents_mode::set_spawn(&instance.server.app, |_argv, _environment| None);

    let client = client();
    let started = std::time::Instant::now();
    let response = client
        .post(format!("{}/agents/dead-code/runs", instance.base))
        .header("accept", "application/json")
        .send()
        .await
        .expect("a response");
    assert_eq!(response.status().as_u16(), 201);
    let body: serde_json::Value = response.json().await.expect("JSON");
    let starting = body["frames"]
        .as_array()
        .and_then(|frames| {
            frames
                .iter()
                .find(|frame| frame["type"] == "agentState" && frame["agent"]["id"] == "dead-code")
        })
        .expect("a starting frame");
    assert!(started.elapsed() <= std::time::Duration::from_millis(1000));
    assert_eq!(starting["agent"]["lifecycle"], "starting");
    assert!(
        !completed.load(std::sync::atomic::Ordering::SeqCst),
        "the starting frame was only written after the preflight finished"
    );

    release.notify_one();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let response = client
            .get(format!("{}/agents/dead-code", instance.base))
            .header("accept", "application/json")
            .send()
            .await
            .expect("a response");
        let body: serde_json::Value = response.json().await.expect("JSON");
        let lifecycle = body["frames"]
            .as_array()
            .and_then(|frames| {
                frames.iter().find_map(|frame| {
                    if frame["type"] == "agentState" && frame["agent"]["id"] == "dead-code" {
                        frame["agent"]["lifecycle"].as_str()
                    } else {
                        None
                    }
                })
            })
            .unwrap_or("stopped");
        if lifecycle != "starting" {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the final snapshot never replaced the starting preview"
        );
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

/// A Start's answer belongs to the command, never to whatever else the
/// dashboard is broadcasting. The request connection used to receive every
/// broadcast, so another family's live activity line — the agent poll ticks
/// every 250 ms and sends several frames per tick — reset the quiet window the
/// reply waits behind and held the answer until the slow preflight finished.
/// The preview must answer inside the client's one-second budget while that
/// preflight is still pending.
#[tokio::test]
async fn a_start_answer_is_not_withheld_behind_unrelated_frames() {
    let instance = start("start-traffic").await;
    devboard::agents_mode::set_preflight(
        &instance.server.app,
        "single-responsibility",
        std::sync::Arc::new(|_request| {
            Box::pin(async {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                Ok("owner/repository".to_string())
            })
        }),
    );
    devboard::agents_mode::set_agent_environment(&instance.server.app, || {
        Box::pin(async { Ok(std::collections::HashMap::new()) })
    });
    devboard::agents_mode::set_spawn(&instance.server.app, |_argv, _environment| None);
    // One frame every 100 ms, well inside the 250 ms answer window: a live
    // worker's activity delta and the poll's changed snapshot both arrive this
    // way, addressed to every registered connection.
    let app = std::sync::Arc::clone(&instance.server.app);
    let traffic = tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            app.shared.send_all(
                serde_json::json!({
                    "type": "issuesActivity",
                    "runId": "run-1",
                    "entries": [{"text": "a line", "append": true}],
                }),
                None,
            );
        }
    });
    let response = tokio::time::timeout(
        std::time::Duration::from_millis(750),
        client()
            .post(format!(
                "{}/agents/single-responsibility/runs",
                instance.base
            ))
            .header("accept", "application/json")
            .send(),
    )
    .await
    .expect("the Start answered inside the client's one-second budget")
    .expect("a response");
    traffic.abort();
    assert_eq!(response.status().as_u16(), 201);
    let body: serde_json::Value = response.json().await.expect("JSON");
    let frames = body["frames"].as_array().expect("a frame list");
    assert!(
        frames.iter().all(|frame| frame["type"] != "issuesActivity"),
        "another worker's activity belongs to no request and never joins a reply"
    );
    frames
        .iter()
        .find(|frame| {
            frame["type"] == "agentState"
                && frame["agent"]["id"] == "single-responsibility"
                && frame["agent"]["lifecycle"] == "starting"
        })
        .expect("the preview answered the Start");
}
