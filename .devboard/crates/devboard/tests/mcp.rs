//! The MCP catalog and its per-tool invocation counters.

use std::path::PathBuf;

use serde_json::Value;

fn private_root(label: &str) -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("mcp-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("a fixture root");
    root
}

fn contract_tools() -> Value {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../contract/fixtures/mcp-tools.json");
    let text = std::fs::read_to_string(path).expect("the recorded contract");
    let fixture: Value = serde_json::from_str(&text).expect("contract JSON");
    fixture["tools"].clone()
}

fn field_names(tool: &Value) -> Vec<&str> {
    tool.as_object()
        .expect("a tool object")
        .keys()
        .map(String::as_str)
        .collect()
}

#[test]
fn the_catalog_holds_every_tool_in_name_order() {
    let payload = devboard::mcp::tool_list_payload();
    let tools = payload["tools"].as_array().expect("tools");
    assert_eq!(tools.len(), 36);
    let names: Vec<&str> = tools
        .iter()
        .map(|tool| tool["name"].as_str().expect("a tool name"))
        .collect();
    let mut sorted = names.clone();
    sorted.sort_unstable();
    assert_eq!(names, sorted);
}

#[test]
fn the_first_and_last_tools_keep_their_field_order() {
    let payload = devboard::mcp::tool_list_payload();
    let tools = payload["tools"].as_array().expect("tools");
    let first = &tools[0];
    assert_eq!(
        field_names(first),
        ["name", "title", "description", "inputSchema"]
    );
    assert_eq!(first["name"], "agent_session_read");
    let last = tools.last().expect("a last tool");
    assert_eq!(
        field_names(last),
        ["name", "title", "description", "inputSchema"]
    );
    assert_eq!(last["name"], "watchdog_duplicate_record");
}

#[test]
fn covers_follow_the_input_schema() {
    let payload = devboard::mcp::tool_list_payload();
    let tool = payload["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .find(|tool| tool["name"] == "agent_sessions_list")
        .expect("the covering tool");
    assert_eq!(
        field_names(tool),
        ["name", "title", "description", "inputSchema", "covers"]
    );
}

#[test]
fn the_payload_matches_the_recorded_contract() {
    assert_eq!(
        devboard::mcp::tool_list_payload()["tools"],
        contract_tools()
    );
}

#[test]
fn a_missing_counter_file_reads_as_an_empty_table() {
    let root = private_root("missing");
    let counts = devboard::mcp::tool_invocation_counts(&root.join("state"), &root.join("repo"));
    assert_eq!(counts, serde_json::json!({}));
}

#[test]
fn a_damaged_counter_file_reads_as_an_empty_table() {
    let root = private_root("damaged");
    let repo = root.join("repo");
    let state = root.join("state");
    let path = devboard::mcp::tool_invocation_file(&state, &repo);
    std::fs::create_dir_all(path.parent().expect("a parent")).expect("the counter directory");
    std::fs::write(&path, "this is not a sqlite database").expect("the damaged counter");
    assert_eq!(
        devboard::mcp::tool_invocation_counts(&state, &repo),
        serde_json::json!({})
    );
}

#[test]
fn probe_reads_a_bun_database() {
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.tmp/sqlprobe");
    let state = base.join("state");
    let repo = base.join("checkout");
    if !devboard::mcp::tool_invocation_file(&state, &repo).exists() {
        // The Bun-written probe database is a development fixture, never
        // committed; without it there is nothing to compare against.
        return;
    }
    let counts = devboard::mcp::tool_invocation_counts(&state, &repo);
    assert_eq!(
        counts,
        serde_json::json!({"journal_search": 2, "devboard_status": 1})
    );
}
