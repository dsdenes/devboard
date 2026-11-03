//! The stdio MCP server, driven through its newline-delimited JSON-RPC loop.

use std::collections::HashMap;
use std::path::PathBuf;

use serde_json::{json, Value};

use devboard::mcp_server::{run_stdio, McpContext};

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
    assert!(written.contains("## Stop conditions\n\nWhen it passes\n\n"));

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
