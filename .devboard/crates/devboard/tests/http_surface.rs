//! The HTTP surface table: every path, method, and status family the contract
//! names, exercised against a private in-process listener.

use std::path::{Path, PathBuf};

use devboard::config::Config;
use devboard::http::Server;
use devboard::journal::Journal;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT_ENCODING, AUTHORIZATION, HOST, ORIGIN};
use reqwest::{Method, StatusCode};

const TOKEN: &str = "contract-token";

struct Instance {
    base: String,
    root: PathBuf,
    token: String,
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
        addr_dir: root.join("repo/adrs"),
        repo_dir: root.join("repo"),
        goal_file: root.join("repo/GOAL.md"),
        static_dir: Some(root.join("static")),
        agent_command: "true".to_string(),
        state_dir: root.join("state"),
        allowed_hosts: Vec::new(),
        token: TOKEN.to_string(),
        bootstrap: "test-bootstrap".to_string(),
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
        root,
        token: TOKEN.to_string(),
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

fn bearer(token: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}")).expect("a token"),
    );
    headers
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
        bearer(&instance.token),
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
        bearer(&instance.token),
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
            bearer(&instance.token),
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
    let mut headers = bearer(&instance.token);
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
async fn socket_guards_answer_method_host_origin_and_credential() {
    let instance = start("ws-guards").await;
    let url = format!("{}/ws", instance.base);

    let (status, headers, _body) = send(Method::POST, &url, HeaderMap::new()).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(
        headers.get("allow").and_then(|value| value.to_str().ok()),
        Some("GET")
    );

    let (status, _headers, _body) = send(Method::GET, &url, HeaderMap::new()).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let mut headers = bearer(&instance.token);
    headers.insert(HOST, HeaderValue::from_static("evil.test"));
    let (status, _headers, _body) = send(Method::GET, &url, headers).await;
    assert_eq!(status, StatusCode::MISDIRECTED_REQUEST);

    let mut headers = bearer(&instance.token);
    headers.insert(ORIGIN, HeaderValue::from_static("http://evil.test"));
    let (status, _headers, _body) = send(Method::GET, &url, headers).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, _headers, _body) = send(Method::GET, &url, bearer(&instance.token)).await;
    assert_eq!(status, StatusCode::UPGRADE_REQUIRED);
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

    let (status, headers, _body) = send(
        Method::GET,
        &format!("{}/", instance.base),
        HeaderMap::new(),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        headers
            .get("www-authenticate")
            .and_then(|value| value.to_str().ok()),
        Some("Bearer")
    );
    assert!(
        headers.get("set-cookie").is_none(),
        "no cookie before the credential"
    );

    let (status, headers, body) = send(
        Method::GET,
        &format!("{}/?bootstrap=test-bootstrap", instance.base),
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
    let cookie = headers
        .get("set-cookie")
        .and_then(|value| value.to_str().ok())
        .expect("the document hands out its cookie")
        .to_string();
    assert!(cookie.contains("HttpOnly"));
    assert!(!String::from_utf8_lossy(&body).contains(TOKEN));

    let mut cookie_headers = HeaderMap::new();
    cookie_headers.insert(
        reqwest::header::COOKIE,
        HeaderValue::from_str(cookie.split(';').next().expect("a cookie pair")).expect("a cookie"),
    );
    let (status, _headers, _body) =
        send(Method::GET, &format!("{}/", instance.base), cookie_headers).await;
    assert_eq!(status, StatusCode::OK);

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
async fn mutating_endpoints_enforce_credential_method_and_configuration() {
    let instance = start("endpoints").await;
    for path in ["/feedback", "/goal-proposals"] {
        let url = format!("{}{path}", instance.base);
        let (status, headers, _body) = send(Method::POST, &url, HeaderMap::new()).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{path}");
        assert_eq!(
            headers
                .get("www-authenticate")
                .and_then(|value| value.to_str().ok()),
            Some("Bearer")
        );
    }

    let (status, headers, _body) = send(
        Method::GET,
        &format!("{}/feedback", instance.base),
        bearer(&instance.token),
    )
    .await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(
        headers.get("allow").and_then(|value| value.to_str().ok()),
        Some("POST")
    );

    let (status, _headers, body) = send(
        Method::POST,
        &format!("{}/feedback", instance.base),
        bearer(&instance.token),
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
        bearer(&instance.token),
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
async fn the_socket_accepts_a_recorded_frame() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::Message;

    let instance = start("socket").await;
    let mut request = format!("{}/ws", instance.base.replace("http://", "ws://"))
        .into_client_request()
        .expect("a request");
    request.headers_mut().insert(
        "authorization",
        HeaderValue::from_str(&format!("Bearer {}", instance.token)).expect("a token"),
    );
    let (mut socket, _response) = tokio_tungstenite::connect_async(request)
        .await
        .expect("an upgrade");
    // The connection replays the provider state before any reply.
    let first = loop {
        match socket.next().await {
            Some(Ok(Message::Text(text))) => break text.to_string(),
            Some(Ok(_)) => continue,
            other => panic!("no replay: {other:?}"),
        }
    };
    let replay: serde_json::Value = serde_json::from_str(&first).expect("JSON");
    assert_eq!(replay["type"], "providersState");

    socket
        .send(Message::Text(r#"{"type":"getProject"}"#.into()))
        .await
        .expect("a frame");
    let frame = loop {
        match socket.next().await {
            Some(Ok(Message::Text(text))) => {
                let parsed: serde_json::Value = serde_json::from_str(&text).expect("JSON");
                if parsed["type"] == "project" {
                    break text.to_string();
                }
            }
            Some(Ok(_)) => continue,
            other => panic!("no answer: {other:?}"),
        }
    };
    let parsed: serde_json::Value = serde_json::from_str(&frame).expect("JSON");
    assert_eq!(parsed["type"], "project");
    let path = parsed["path"].as_str().expect("a path");
    assert!(!Path::new(path).is_absolute() || path == instance.root.to_string_lossy());

    socket
        .send(Message::Text("not json".into()))
        .await
        .expect("a frame");
    let frame = loop {
        match socket.next().await {
            Some(Ok(Message::Text(text))) => break text.to_string(),
            Some(Ok(_)) => continue,
            other => panic!("no answer: {other:?}"),
        }
    };
    let parsed: serde_json::Value = serde_json::from_str(&frame).expect("JSON");
    assert_eq!(parsed["type"], "error");
    assert_eq!(parsed["message"], "Invalid WebSocket message.");
    let _ = socket.close(None).await;
}

#[tokio::test]
async fn the_embedded_client_serves_without_a_static_directory() {
    let root = private_root("embedded");
    let config = Config {
        hostname: "127.0.0.1".to_string(),
        port: 0,
        addr_dir: root.join("repo/adrs"),
        repo_dir: root.join("repo"),
        goal_file: root.join("repo/GOAL.md"),
        static_dir: None,
        agent_command: "true".to_string(),
        state_dir: root.join("state"),
        allowed_hosts: Vec::new(),
        token: TOKEN.to_string(),
        bootstrap: "test-bootstrap".to_string(),
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
    let (status, headers, body) = send(Method::GET, &format!("{base}/"), bearer(TOKEN)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers
            .get("content-type")
            .and_then(|value| value.to_str().ok()),
        Some("text/html;charset=utf-8")
    );
    assert!(headers.get("set-cookie").is_some());
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

    let mut headers = bearer(&instance.token);
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

    let mut headers = bearer(&instance.token);
    headers.insert("x-flow-id", HeaderValue::from_static("flow-42"));
    headers.insert(HOST, HeaderValue::from_static("evil.test"));
    let (status, headers, _body) =
        send(Method::GET, &format!("{}/ws", instance.base), headers).await;
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
    for (method, path) in [
        (Method::POST, "/feedback"),
        (Method::POST, "/goal-proposals"),
        (Method::GET, "/goal-proposals/missing.md"),
    ] {
        let mut headers = bearer(&instance.token);
        headers.insert(HOST, HeaderValue::from_static("evil.test"));
        let (status, _headers, body) =
            send(method, &format!("{}{path}", instance.base), headers).await;
        assert_eq!(status, StatusCode::MISDIRECTED_REQUEST, "{path}");
        let parsed: serde_json::Value = serde_json::from_slice(&body).expect("problem JSON");
        assert_eq!(parsed["title"], "Misdirected Request");
    }
}

#[tokio::test]
async fn an_unreadable_static_file_answers_500_and_journals() {
    let instance = start("static-unreadable").await;
    let path = instance.root.join("static/assets/secret.txt");
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
async fn the_readiness_probe_presents_the_credential_and_checks_the_pid() {
    let instance = start("ready-probe").await;
    let port: u16 = instance
        .base
        .rsplit(':')
        .next()
        .and_then(|value| value.parse().ok())
        .expect("the listener port");
    assert!(devboard::relaunch::probe_ready(port, &instance.token, Some(std::process::id())).await);
    assert!(!devboard::relaunch::probe_ready(port, "wrong-token", Some(std::process::id())).await);
    assert!(!devboard::relaunch::probe_ready(port, &instance.token, Some(0)).await);
}
