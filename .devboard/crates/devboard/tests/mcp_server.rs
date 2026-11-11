//! The stdio MCP server, driven through its newline-delimited JSON-RPC loop.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::extract::State;
use serde_json::{json, Value};

use devboard::mcp_server::{run_stdio, LiveDashboard, McpContext};

fn private_root(label: &str) -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("mcp-server-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("a fixture root");
    root
}

fn fixture(context_label: &str) -> McpContext {
    let root = private_root(context_label);
    let repo = root.join("repo");
    let harness = repo.join(".devboard");
    let state = root.join("state");
    std::fs::create_dir_all(&repo).expect("the repo");
    // The fixture is its own repository: the status tool runs `git -C` here,
    // and without a `.git` it would walk up into the checkout the test runs
    // from and report that checkout's branch and ahead count instead.
    let initialized = std::process::Command::new("git")
        .args(["init", "-q"])
        .arg(&repo)
        .status()
        .expect("git runs");
    assert!(initialized.success(), "the fixture repo is initialized");
    std::fs::create_dir_all(&harness).expect("the harness");
    std::fs::create_dir_all(&state).expect("the state");
    std::fs::write(repo.join("GOAL.md"), "the goal").expect("the goal document");
    std::fs::write(
        harness.join("package.json"),
        r#"{"name":"fixture","version":"0.0.0","scripts":{"verify:fixture":"printf 'hello'"}}"#,
    )
    .expect("the fixture package");
    McpContext {
        repo_dir: repo.clone(),
        harness_dir: harness,
        state_dir: state.clone(),
        environment: HashMap::new(),
        dashboards: Some(Vec::new()),
    }
}

fn write_transcript(context: &McpContext) {
    let directory = context
        .state_dir
        .join("providers")
        .join("agents")
        .join("scout")
        .join("sessions");
    std::fs::create_dir_all(&directory).expect("the transcript directory");
    let cwd = context.repo_dir.to_string_lossy().replace('\\', "/");
    let lines = [
        format!(r#"{{"type":"session","id":"session-1","timestamp":"2026-01-01T00:00:00.000Z","cwd":"{cwd}"}}"#),
        r#"{"type":"title","title":"A fixture session"}"#.to_string(),
        r#"{"type":"message","timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"hello world"}}"#.to_string(),
        r#"{"type":"message","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"answer"}],"usage":{"input":3,"output":4,"cacheRead":1,"cacheWrite":0,"cost":{"total":0.01}}}}"#.to_string(),
        r#"{"type":"message","timestamp":"2026-01-01T00:00:03.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"bash","arguments":{"command":"ls -la"}}],"usage":{"input":1,"output":1}}}"#.to_string(),
        r#"{"type":"message","timestamp":"2026-01-01T00:00:04.000Z","message":{"role":"toolResult","toolName":"bash","toolCallId":"c1","content":"boom failure","isError":true}}"#.to_string(),
        "not json".to_string(),
    ];
    std::fs::write(directory.join("a.jsonl"), lines.join("\n")).expect("the transcript");
}

fn write_journal(context: &McpContext) {
    let path = devboard::journal::journal_file(&context.state_dir, &context.repo_dir);
    std::fs::create_dir_all(path.parent().expect("a journal parent"))
        .expect("the journal directory");
    std::fs::write(
        &path,
        concat!(
            r#"{"ts":"2026-01-01T00:00:00.000Z","kind":"activity","text":"hello journal","scope":"run-a"}"#,
            "\n",
        ),
    )
    .expect("the journal");
}

async fn drive(context: &McpContext, requests: &[Value]) -> Vec<Value> {
    let mut input = String::new();
    for request in requests {
        input.push_str(&serde_json::to_string(request).expect("a request"));
        input.push('\n');
    }
    let mut output: Vec<u8> = Vec::new();
    let mut diagnostics: Vec<u8> = Vec::new();
    run_stdio(
        context.clone(),
        input.as_bytes(),
        &mut output,
        &mut diagnostics,
    )
    .await
    .expect("the stdio loop");
    String::from_utf8_lossy(&output)
        .split('\n')
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_str(line).expect("a JSON-RPC frame"))
        .collect()
}

fn reply(frames: &[Value], id: i64) -> &Value {
    frames
        .iter()
        .find(|frame| frame.get("id").and_then(Value::as_i64) == Some(id))
        .unwrap_or_else(|| panic!("a reply for {id}"))
}

fn tool_result(frames: &[Value], id: i64) -> Value {
    let frame = reply(frames, id);
    let text = frame["result"]["content"][0]["text"]
        .as_str()
        .expect("tool text");
    serde_json::from_str::<Value>(text).expect("tool JSON")
}

#[tokio::test]
async fn the_stdio_server_answers_initialize_list_and_the_core_tools() {
    let context = fixture("core");
    write_transcript(&context);
    write_journal(&context);
    let spec_slug = "the-objective";
    let requests = vec![
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-01-01"}}),
        json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
        json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
        json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "devboard_status", "arguments": {}}}),
        json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "goal_get", "arguments": {}}}),
        json!({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "goal_spec_write", "arguments": {
            "objective": "The objective",
            "successCriteria": "It works",
            "verification": "Run the test",
            "boundaries": "Only this file",
            "stopConditions": "When it passes",
            "slug": spec_slug,
        }}}),
        json!({"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "journal_search", "arguments": {"kind": "activity"}}}),
        json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "agent_sessions_list", "arguments": {}}}),
        json!({"jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": {"name": "agent_session_read", "arguments": {"id": "session-1"}}}),
        json!({"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {"name": "agent_session_search", "arguments": {"query": "BOOM"}}}),
        json!({"jsonrpc": "2.0", "id": 10, "method": "tools/call", "params": {"name": "verification_run", "arguments": {"check": "verify:fixture"}}}),
    ];
    let frames = drive(&context, &requests).await;
    assert_eq!(
        frames.len(),
        10,
        "one reply per id, notifications stay silent"
    );

    let initialize = reply(&frames, 1);
    assert_eq!(initialize["jsonrpc"], "2.0");
    assert_eq!(initialize["id"], 1);
    assert_eq!(initialize["result"]["protocolVersion"], "2025-01-01");
    assert_eq!(initialize["result"]["serverInfo"]["name"], "devboard");
    assert_eq!(
        initialize["result"]["capabilities"]["tools"]["listChanged"],
        false
    );

    assert_eq!(
        reply(&frames, 2)["result"],
        devboard::mcp::tool_list_payload(),
        "tools/list equals the one catalog"
    );

    let status = tool_result(&frames, 3);
    assert_eq!(
        status["repositoryRoot"].as_str().expect("a root"),
        context.repo_dir.to_string_lossy()
    );
    assert_eq!(
        status["stateDirectory"].as_str().expect("a state root"),
        context.state_dir.to_string_lossy()
    );
    assert_eq!(status["dashboard"], Value::Null);
    assert!(status["version"].is_object());
    assert_eq!(status["git"]["ahead"], 0);

    let goal = tool_result(&frames, 4);
    assert_eq!(goal["goal"], "the goal");
    assert_eq!(goal["truncated"], false);

    let spec = tool_result(&frames, 5);
    assert_eq!(spec["path"], ".devboard/goals/the-objective.md");
    assert_eq!(spec["slug"], "the-objective");
    let written =
        std::fs::read_to_string(context.repo_dir.join(".devboard/goals/the-objective.md"))
            .expect("the written spec");
    assert!(written.starts_with("## Objective\n\nThe objective\n\n"));
    assert!(written.contains("## Stop conditions\n\nWhen it passes\n"));
    assert!(written.ends_with("When it passes\n"), "{written:?}");
    assert!(
        !written.ends_with("\n\n"),
        "exactly one newline ends the file"
    );

    let journal = tool_result(&frames, 6);
    assert_eq!(journal["total"], 1);
    assert_eq!(journal["records"][0]["text"], "hello journal");
    assert_eq!(journal["records"][0]["scope"], "run-a");

    let sessions = tool_result(&frames, 7);
    assert_eq!(sessions["total"], 1);
    assert_eq!(sessions["sessions"][0]["id"], "session-1");
    assert_eq!(sessions["sessions"][0]["title"], "A fixture session");
    assert_eq!(sessions["sessions"][0]["messageCount"], 4);
    assert_eq!(sessions["sessions"][0]["toolErrorCount"], 1);
    assert_eq!(sessions["sessions"][0]["tokens"]["input"], 4);
    assert_eq!(sessions["sessions"][0]["tokens"]["output"], 5);
    assert_eq!(sessions["sessions"][0]["tokens"]["total"], 10);
    assert_eq!(
        sessions["sessions"][0]["relativePath"],
        "providers/agents/scout/sessions/a.jsonl"
    );

    let page = tool_result(&frames, 8);
    assert_eq!(page["id"], "session-1");
    assert_eq!(page["total"], 4);
    assert_eq!(page["messages"][0]["role"], "user");
    assert_eq!(page["messages"][1]["text"], "answer");
    assert_eq!(page["messages"][2]["toolName"], "bash");
    assert_eq!(page["messages"][3]["isError"], true);
    assert_eq!(page["malformed"], 1);
    let fingerprint = page["messages"][3]["errorFingerprint"]
        .as_str()
        .expect("a fingerprint");
    assert_eq!(fingerprint.len(), 16);

    let search = tool_result(&frames, 9);
    assert_eq!(search["truncated"], false);
    assert_eq!(search["matches"][0]["sessionId"], "session-1");
    assert_eq!(search["matches"][0]["role"], "toolResult");
    assert_eq!(search["matches"][0]["snippet"], "boom failure");

    let verification = tool_result(&frames, 10);
    assert_eq!(verification["check"], "verify:fixture");
    assert_eq!(verification["exitCode"], 0);
    assert!(verification["output"]
        .as_str()
        .expect("the captured output")
        .contains("hello"));
    assert_eq!(verification["truncated"], false);
    let log = verification["log"].as_str().expect("the log path");
    assert!(log.ends_with(".log"));
    let absolute = context.repo_dir.join(log);
    assert!(absolute.exists(), "the relative log path resolves");

    let counts = devboard::mcp::tool_invocation_counts(&context.state_dir, &context.repo_dir);
    assert_eq!(counts["devboard_status"], 1);
    assert_eq!(counts["goal_spec_write"], 1);
    assert_eq!(counts["agent_sessions_list"], 1);
    assert_eq!(counts["verification_run"], 1);
}

#[tokio::test]
async fn the_stdio_server_refuses_bad_frames_and_tool_calls() {
    let context = fixture("refusals");
    let mut input = String::from("{not json}\n");
    input.push_str(
        &serde_json::to_string(&json!({
            "jsonrpc": "2.0",
            "id": 20,
            "method": "tools/call",
            "params": {"name": "designmd_get_design_kit", "arguments": {}}
        }))
        .expect("a request"),
    );
    input.push('\n');
    input.push_str(
        &serde_json::to_string(&json!({
            "jsonrpc": "2.0",
            "id": 21,
            "method": "tools/call",
            "params": {"name": "journal_search", "arguments": {"kind": "nonsense"}}
        }))
        .expect("a request"),
    );
    input.push('\n');
    input.push_str(
        &serde_json::to_string(&json!({
            "jsonrpc": "2.0",
            "id": 22,
            "method": "tools/call",
            "params": {"name": "goal_spec_write", "arguments": {}}
        }))
        .expect("a request"),
    );
    input.push('\n');
    input.push_str(
        &serde_json::to_string(&json!({
            "jsonrpc": "2.0",
            "id": 23,
            "method": "notifications/unknown"
        }))
        .expect("a request"),
    );
    input.push('\n');
    input.push_str(
        &serde_json::to_string(&json!({
            "jsonrpc": "2.0",
            "id": 24,
            "method": "not/a_method"
        }))
        .expect("a request"),
    );
    input.push('\n');
    let mut output: Vec<u8> = Vec::new();
    let mut diagnostics: Vec<u8> = Vec::new();
    run_stdio(
        context.clone(),
        input.as_bytes(),
        &mut output,
        &mut diagnostics,
    )
    .await
    .expect("the stdio loop");
    let frames: Vec<Value> = String::from_utf8_lossy(&output)
        .split('\n')
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_str(line).expect("a frame"))
        .collect();
    assert_eq!(frames.len(), 5, "the notification produces no reply");
    assert_eq!(frames[0]["id"], Value::Null);
    assert_eq!(frames[0]["error"]["code"], -32700);
    assert_eq!(frames[0]["error"]["message"], "Parse error");

    let unknown = reply(&frames, 20);
    assert_eq!(unknown["result"]["isError"], true);
    let text = unknown["result"]["content"][0]["text"]
        .as_str()
        .expect("tool text");
    assert!(text.contains("Unknown tool: designmd_get_design_kit"));

    let journal = reply(&frames, 21);
    assert_eq!(journal["result"]["isError"], true);
    let text = journal["result"]["content"][0]["text"]
        .as_str()
        .expect("tool text");
    assert!(text.contains("kind must be one of: activity"));

    let missing = reply(&frames, 22);
    assert_eq!(missing["result"]["isError"], true);
    let text = missing["result"]["content"][0]["text"]
        .as_str()
        .expect("tool text");
    assert!(text.contains("arguments.objective is required."));

    let method = reply(&frames, 24);
    assert_eq!(method["error"]["code"], -32601);
    assert_eq!(method["error"]["message"], "Method not found: not/a_method");
}

#[tokio::test]
async fn a_malformed_line_is_counted_not_guessed() {
    let context = fixture("malformed");
    write_transcript(&context);
    let frames = drive(
        &context,
        &[json!({
            "jsonrpc": "2.0",
            "id": 30,
            "method": "tools/call",
            "params": {"name": "agent_session_read", "arguments": {"id": "session-1"}}
        })],
    )
    .await;
    let page = tool_result(&frames, 30);
    assert_eq!(page["malformed"], 1);
    assert_eq!(page["truncated"], false);
    assert_eq!(page["nextOffset"], Value::Null);
    assert_eq!(page["messages"][2]["toolName"], "bash");
    assert_eq!(
        page["messages"][3]["errorFingerprint"]
            .as_str()
            .unwrap()
            .len(),
        16
    );
    let missing = drive(
        &context,
        &[json!({
            "jsonrpc": "2.0",
            "id": 31,
            "method": "tools/call",
            "params": {"name": "agent_session_read", "arguments": {"id": "nope"}}
        })],
    )
    .await;
    let frame = reply(&missing, 31);
    assert_eq!(frame["result"]["isError"], true);
    assert!(frame["result"]["content"][0]["text"]
        .as_str()
        .expect("tool text")
        .contains("No session nope in this repository's evidence."));
}

// ---------------------------------------------------------------------------
// Watchdog deduplication records
// ---------------------------------------------------------------------------

type StubCalls = Arc<Mutex<Vec<String>>>;

/// Answers the three Gitea requests one filed candidate makes: the identity,
/// the checkout's push permission, and the created issue.
async fn stub_gitea_entry(
    State(calls): State<StubCalls>,
    request: axum::extract::Request,
) -> axum::response::Response {
    let method = request.method().as_str().to_string();
    let path = request.uri().path().to_string();
    let host = request
        .headers()
        .get("host")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("127.0.0.1")
        .to_string();
    calls
        .lock()
        .expect("calls")
        .push(format!("{method} {path}"));
    let (status, body) = match (method.as_str(), path.as_str()) {
        ("GET", "/api/v1/user") => (200, json!({"login": "alice"}).to_string()),
        ("GET", "/api/v1/repos/owner/name") => (
            200,
            json!({"permissions": {"pull": true, "push": true, "admin": false}}).to_string(),
        ),
        ("POST", "/api/v1/repos/owner/name/issues") => (
            201,
            json!({
                "number": 101,
                "title": "[watchdog] update-error: boom",
                "html_url": format!("http://{host}/owner/name/issues/101"),
                "state": "open",
                "body": "the body",
                "labels": [],
                "created_at": "2026-01-01T00:00:00.000Z",
            })
            .to_string(),
        ),
        _ => (500, format!("unexpected {method} {path}")),
    };
    axum::response::Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(axum::body::Body::from(body))
        .expect("a stub response")
}

#[tokio::test]
async fn a_dedup_run_records_the_issue_the_turn_files() {
    let calls: StubCalls = Arc::new(Mutex::new(Vec::new()));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("a stub listener");
    let port = listener.local_addr().expect("an address").port();
    let app = axum::Router::new()
        .fallback(stub_gitea_entry)
        .with_state(calls.clone());
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let mut context = fixture("dedup-filed");
    let remote = format!("http://127.0.0.1:{port}/owner/name.git");
    let added = std::process::Command::new("git")
        .arg("-C")
        .arg(&context.repo_dir)
        .args(["remote", "add", "origin", &remote])
        .status()
        .expect("git runs");
    assert!(added.success(), "the fixture origin is added");
    let run_dir = context
        .state_dir
        .join("watchdog")
        .join("runs")
        .join("cycle")
        .join("dedup");
    std::fs::create_dir_all(&run_dir).expect("the dedup run directory");
    context.environment = HashMap::from([
        ("GITEA_TOKEN".to_string(), "secret".to_string()),
        (
            "DEVBOARD_DEDUP_RUN_DIR".to_string(),
            run_dir.to_string_lossy().into_owned(),
        ),
    ]);

    let frames = drive(
        &context,
        &[
            json!({
                "jsonrpc": "2.0",
                "id": 40,
                "method": "tools/call",
                "params": {
                    "name": "issue_create",
                    "arguments": {
                        "title": "[watchdog] update-error: boom",
                        "body": "the body",
                        "fingerprint": "fp-1"
                    }
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 41,
                "method": "tools/call",
                "params": {
                    "name": "issue_create",
                    "arguments": {
                        "title": "[watchdog] update-error: again",
                        "body": "the body"
                    }
                }
            }),
        ],
    )
    .await;

    let created = tool_result(&frames, 40);
    let url = format!("http://127.0.0.1:{port}/owner/name/issues/101");
    assert_eq!(created["number"], 101);
    assert_eq!(created["url"], url);

    let unattributed = reply(&frames, 41);
    assert_eq!(unattributed["result"]["isError"], true);
    assert!(unattributed["result"]["content"][0]["text"]
        .as_str()
        .expect("tool text")
        .contains("fingerprint is required"));

    let records = devboard::workers::watchdog::read_dedup_records(&run_dir);
    assert_eq!(records.len(), 1, "one filed candidate, one record");
    assert_eq!(records[0].fingerprint, "fp-1");
    assert_eq!(records[0].action, "filed");
    assert_eq!(records[0].number, Some(101));
    assert_eq!(records[0].url.as_deref(), Some(url.as_str()));

    let posts = calls
        .lock()
        .expect("calls")
        .iter()
        .filter(|call| call.as_str() == "POST /api/v1/repos/owner/name/issues")
        .count();
    assert_eq!(posts, 1, "the refused call files nothing");
    server.abort();
}

/// Answers the two identity requests one Gitea read makes and refuses the
/// issue read itself the way a rejected credential does.
async fn stub_gitea_refused_read(request: axum::extract::Request) -> axum::response::Response {
    let method = request.method().as_str().to_string();
    let path = request.uri().path().to_string();
    let (status, body) = match (method.as_str(), path.as_str()) {
        ("GET", "/api/v1/user") => (200, json!({"login": "alice"}).to_string()),
        ("GET", "/api/v1/repos/owner/name") => (
            200,
            json!({"permissions": {"pull": true, "push": false, "admin": false}}).to_string(),
        ),
        _ => (
            401,
            json!({"message": "invalid username, password or token"}).to_string(),
        ),
    };
    axum::response::Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(axum::body::Body::from(body))
        .expect("a stub response")
}

#[tokio::test]
async fn a_refused_dedup_read_is_recorded_for_the_cycle() {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("a stub listener");
    let port = listener.local_addr().expect("an address").port();
    let app = axum::Router::new().fallback(stub_gitea_refused_read);
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let mut context = fixture("dedup-refused-read");
    let remote = format!("http://127.0.0.1:{port}/owner/name.git");
    let added = std::process::Command::new("git")
        .arg("-C")
        .arg(&context.repo_dir)
        .args(["remote", "add", "origin", &remote])
        .status()
        .expect("git runs");
    assert!(added.success(), "the fixture origin is added");
    let run_dir = context
        .state_dir
        .join("watchdog")
        .join("runs")
        .join("cycle")
        .join("dedup");
    std::fs::create_dir_all(&run_dir).expect("the dedup run directory");
    context.environment = HashMap::from([
        ("GITEA_TOKEN".to_string(), "secret".to_string()),
        (
            "DEVBOARD_DEDUP_RUN_DIR".to_string(),
            run_dir.to_string_lossy().into_owned(),
        ),
    ]);

    let frames = drive(
        &context,
        &[json!({
            "jsonrpc": "2.0",
            "id": 50,
            "method": "tools/call",
            "params": {
                "name": "issues_list",
                "arguments": {"state": "open"}
            }
        })],
    )
    .await;

    let refused = reply(&frames, 50);
    assert_eq!(refused["result"]["isError"], true);
    let text = refused["result"]["content"][0]["text"]
        .as_str()
        .expect("tool text")
        .to_string();
    assert!(text.contains("HTTP 401"), "{text}");
    assert!(
        text.contains("Gitea list issues for owner/name failed: "),
        "the tool names the forge, the operation, and the cause: {text}"
    );

    let errors = devboard::workers::watchdog::read_dedup_errors(&run_dir);
    assert_eq!(errors.len(), 1, "the refused read is recorded once");
    assert!(
        errors[0].starts_with("issues_list: Gitea list issues for owner/name failed: GET "),
        "the record names the tool, the forge, the operation, and the request: {}",
        errors[0]
    );
    assert!(
        errors[0].contains("failed (HTTP 401): invalid username, password or token"),
        "the record carries the forge's refusal: {}",
        errors[0]
    );
    server.abort();
}

/// How many issues the paged tracker below holds.
const PAGED_TRACKER_ISSUES: i64 = 260;

/// One row of the paged tracker: number `number`, created `number` minutes
/// after the epoch, so the newest row is the highest number.
fn paged_tracker_issue(number: i64) -> Value {
    json!({
        "number": number,
        "title": format!("Issue {number}"),
        "html_url": format!("https://gitea.test/owner/name/issues/{number}"),
        "created_at": format!("2024-01-01T{:02}:{:02}:00Z", number / 60, number % 60),
        "state": "open",
        "body": format!("body {number}"),
        "labels": [],
    })
}

fn stub_query_value(query: &str, name: &str) -> String {
    query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value.to_string())
        .unwrap_or_default()
}

/// A Gitea tracker of `PAGED_TRACKER_ISSUES` issues that honors `limit`,
/// `page`, and the requested direction.
async fn stub_gitea_paged_tracker(
    State(calls): State<StubCalls>,
    request: axum::extract::Request,
) -> axum::response::Response {
    let method = request.method().as_str().to_string();
    let uri = request.uri().clone();
    calls
        .lock()
        .expect("calls")
        .push(format!("{method} {}", uri.path()));
    let query = uri.query().unwrap_or("").to_string();
    let (status, body) = match (method.as_str(), uri.path()) {
        ("GET", "/api/v1/user") => (200, json!({"login": "alice"}).to_string()),
        ("GET", "/api/v1/repos/owner/name") => (
            200,
            json!({"permissions": {"pull": true, "push": false, "admin": false}}).to_string(),
        ),
        ("GET", "/api/v1/repos/owner/name/issues") => {
            let page: usize = stub_query_value(&query, "page").parse().unwrap_or(1);
            let limit: usize = stub_query_value(&query, "limit").parse().unwrap_or(50);
            let mut numbers: Vec<i64> = (1..=PAGED_TRACKER_ISSUES).collect();
            if stub_query_value(&query, "direction") == "desc" {
                numbers.reverse();
            }
            let rows: Vec<Value> = numbers
                .into_iter()
                .skip((page - 1) * limit)
                .take(limit)
                .map(paged_tracker_issue)
                .collect();
            (200, Value::Array(rows).to_string())
        }
        _ => (500, format!("unexpected {method} {}", uri.path())),
    };
    axum::response::Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(axum::body::Body::from(body))
        .expect("a stub response")
}

/// One `issues_list` read of a large tracker costs one newest-first page per
/// limit, and still reports the rows it returns as truncated.
#[tokio::test]
async fn issues_list_reads_one_bounded_page_from_a_large_tracker() {
    let calls: StubCalls = Arc::new(Mutex::new(Vec::new()));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("a stub listener");
    let port = listener.local_addr().expect("an address").port();
    let app = axum::Router::new()
        .fallback(stub_gitea_paged_tracker)
        .with_state(calls.clone());
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let mut context = fixture("issues-list-bounded");
    let remote = format!("http://127.0.0.1:{port}/owner/name.git");
    let added = std::process::Command::new("git")
        .arg("-C")
        .arg(&context.repo_dir)
        .args(["remote", "add", "origin", &remote])
        .status()
        .expect("git runs");
    assert!(added.success(), "the fixture origin is added");
    context.environment = HashMap::from([
        ("GITEA_TOKEN".to_string(), "secret".to_string()),
        (
            "DEVBOARD_GITEA_URL".to_string(),
            format!("http://127.0.0.1:{port}"),
        ),
    ]);

    let page_requests = || -> usize {
        calls
            .lock()
            .expect("calls")
            .iter()
            .filter(|call| call.as_str() == "GET /api/v1/repos/owner/name/issues")
            .count()
    };

    for (id, limit) in [(60, 100usize), (61, 200usize)] {
        let frames = drive(
            &context,
            &[json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": "tools/call",
                "params": {
                    "name": "issues_list",
                    "arguments": {"state": "open", "limit": limit}
                }
            })],
        )
        .await;
        let listed = tool_result(&frames, id);
        let rows = listed["issues"].as_array().expect("issue rows");
        assert_eq!(rows.len(), limit, "the limit is the row count");
        assert_eq!(rows[0]["number"], PAGED_TRACKER_ISSUES);
        assert_eq!(
            rows[limit - 1]["number"],
            PAGED_TRACKER_ISSUES - limit as i64 + 1,
            "newest first across the returned rows"
        );
        assert_eq!(
            listed["truncated"], true,
            "a tracker larger than the limit is truncated"
        );
    }

    assert_eq!(
        page_requests(),
        2,
        "one newest-first page per issues_list read"
    );
    server.abort();
}

// ---------------------------------------------------------------------------
// Dashboard refusals
// ---------------------------------------------------------------------------

/// Answers a refused Issues control with the dashboard's `error` frame, an
/// accepted pause with the Issues snapshot, and a `getIssues` read with the
/// unchanged snapshot.
async fn stub_dashboard_issues_control(
    State(calls): State<StubCalls>,
    request: axum::extract::Request,
) -> axum::response::Response {
    let method = request.method().as_str().to_string();
    let path = request.uri().path().to_string();
    calls
        .lock()
        .expect("calls")
        .push(format!("{method} {path}"));
    let (status, frames): (u16, Value) = match (method.as_str(), path.as_str()) {
        ("POST", "/issues/workers") => (
            201,
            json!([{"type": "error", "message": "No issues worker is running for this checkout."}]),
        ),
        ("PUT", "/issues/workers") => (
            200,
            json!([{"type": "error", "message": "No issues worker is running for this checkout."}]),
        ),
        ("PATCH", "/issues/workers") => (200, json!([{"type": "issuesState", "issues": []}])),
        ("GET", "/issues") => (
            200,
            json!([{"type": "issuesState", "issues": [], "worker": null}]),
        ),
        _ => (500, json!([{"type": "error", "message": "unexpected"}])),
    };
    let body = json!({"frames": frames}).to_string();
    axum::response::Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(axum::body::Body::from(body))
        .expect("a stub response")
}

/// A control command the dashboard refuses with its `error` frame answers that
/// refusal, and a refused control sends no follow-up read.
#[tokio::test]
async fn a_refused_issues_control_answers_the_dashboards_error_frame() {
    let calls: StubCalls = Arc::new(Mutex::new(Vec::new()));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("a stub listener");
    let port = listener.local_addr().expect("an address").port();
    let app = axum::Router::new()
        .fallback(stub_dashboard_issues_control)
        .with_state(calls.clone());
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let mut context = fixture("issues-refused-control");
    let repo_dir = context.repo_dir.to_string_lossy().into_owned();
    let harness = context.harness_dir.to_string_lossy().into_owned();
    let state_dir = context.state_dir.to_string_lossy().into_owned();
    context.dashboards = Some(vec![LiveDashboard {
        pid: std::process::id(),
        port,
        repo_dir,
        harness,
        state_dir,
    }]);

    let frames = drive(
        &context,
        &[
            json!({
                "jsonrpc": "2.0",
                "id": 70,
                "method": "tools/call",
                "params": {"name": "issues_control", "arguments": {"action": "resume"}}
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 71,
                "method": "tools/call",
                "params": {"name": "issues_control", "arguments": {"action": "start"}}
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 72,
                "method": "tools/call",
                "params": {"name": "issues_control", "arguments": {"action": "pause"}}
            }),
        ],
    )
    .await;

    for id in [70, 71] {
        let refused = reply(&frames, id);
        assert_eq!(refused["result"]["isError"], true, "call {id} is refused");
        let text = refused["result"]["content"][0]["text"]
            .as_str()
            .expect("tool text");
        assert!(
            text.contains("No issues worker is running for this checkout."),
            "call {id} carries the dashboard's message: {text}"
        );
    }

    let accepted = tool_result(&frames, 72);
    assert_eq!(accepted["action"], "pause");
    assert_eq!(accepted["issues"]["issues"], json!([]));

    let reads = calls
        .lock()
        .expect("calls")
        .iter()
        .filter(|call| call.as_str() == "GET /issues")
        .count();
    assert_eq!(reads, 0, "a refused control sends no follow-up read");
    server.abort();
}

/// The description limit counts characters in the staging tool exactly as the
/// publication validator does: a CJK description longer than 1024 bytes stages,
/// and one character over the cap is refused in characters.
#[tokio::test]
async fn a_staged_skill_description_is_capped_in_characters() {
    let context = fixture("skill-description-cap");
    let staging = context
        .repo_dir
        .join(".omp")
        .join("discover")
        .join("staging")
        .join("run-1");
    std::fs::create_dir_all(&staging).expect("the staging directory");
    let at_cap = "技".repeat(1024);
    assert!(at_cap.len() > 1024, "the description exceeds 1024 bytes");
    let over_cap = "技".repeat(1025);

    let frames = drive(
        &context,
        &[
            json!({
                "jsonrpc": "2.0",
                "id": 80,
                "method": "tools/call",
                "params": {
                    "name": "discover_skill_stage",
                    "arguments": {
                        "stagingDir": "run-1",
                        "name": "discover-testing-strategy",
                        "description": at_cap,
                        "body": "# Testing\n\n- Run the suite.",
                    }
                }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 81,
                "method": "tools/call",
                "params": {
                    "name": "discover_skill_stage",
                    "arguments": {
                        "stagingDir": "run-1",
                        "name": "discover-testing-strategy",
                        "description": over_cap,
                        "body": "# Testing\n\n- Run the suite.",
                    }
                }
            }),
        ],
    )
    .await;

    let staged = tool_result(&frames, 80);
    assert_eq!(staged["name"], "discover-testing-strategy");
    let document =
        std::fs::read_to_string(staging.join("skills/discover-testing-strategy/SKILL.md"))
            .expect("the staged skill");
    assert!(
        document.contains(&at_cap),
        "the staged skill carries the full description"
    );

    let refused = reply(&frames, 81);
    assert_eq!(refused["result"]["isError"], true);
    let message = refused["result"]["content"][0]["text"]
        .as_str()
        .expect("tool text");
    assert!(
        message.contains("description must be at most 1024 characters."),
        "{message}"
    );
}
