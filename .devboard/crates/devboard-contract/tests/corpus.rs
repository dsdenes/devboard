//! The contract corpus gates: handler coverage, replay of every implemented
//! command, the HTTP table, and a deliberately broken fixture that proves the
//! replay is not vacuous.

use devboard::http::Server;
use devboard::journal::Journal;
use devboard_contract::{dashboard_config, http_table};
use std::path::PathBuf;
use std::sync::Arc;

fn corpus_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../contract")
}

#[test]
fn the_allowlist_names_a_reason_for_every_field() {
    let corpus = devboard_contract::Corpus::load(&corpus_root()).expect("the corpus loads");
    assert!(!corpus.allowlist.fields.is_empty());
    for field in &corpus.allowlist.fields {
        assert!(
            field.reason.split_whitespace().count() >= 2,
            "{} needs a real reason",
            field.name
        );
    }
}

#[test]
fn every_recorded_event_type_has_one_corpus_entry() {
    let root = corpus_root();
    let corpus = devboard_contract::Corpus::load(&root).expect("the corpus loads");
    let mut recorded = std::collections::BTreeSet::new();
    for entry in std::fs::read_dir(root.join("events")).expect("the event directory") {
        let path = entry.expect("an entry").path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("an event recording"))
                .expect("event JSON");
        recorded.insert(
            value
                .get("type")
                .and_then(serde_json::Value::as_str)
                .expect("an event type")
                .to_string(),
        );
        assert!(
            value.get("frame").is_some_and(|frame| !frame.is_null()),
            "{} names an exemplar frame",
            path.display()
        );
        if value.get("type").and_then(serde_json::Value::as_str) == Some("versionState") {
            let names: Vec<&str> = value
                .get("scenarios")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|scenario| scenario.get("name").and_then(|name| name.as_str()))
                .collect();
            assert!(
                names.contains(&"source"),
                "versionState records a source host"
            );
            assert!(
                names.contains(&"installed"),
                "versionState records an installed host"
            );
        }
    }
    let observed = corpus.event_types();
    assert_eq!(
        recorded, observed,
        "event recordings must match observed types"
    );
}

#[test]
fn every_corpus_command_has_a_handler_and_every_handler_has_a_recording() {
    let corpus = devboard_contract::Corpus::load(&corpus_root()).expect("the corpus loads");
    let recorded = corpus.command_names();
    let implemented: std::collections::BTreeSet<String> = devboard::app::IMPLEMENTED_COMMANDS
        .iter()
        .map(|name| (*name).to_string())
        .collect();
    let missing: Vec<&String> = recorded.difference(&implemented).collect();
    assert!(
        missing.is_empty(),
        "corpus commands with no Rust handler: {missing:?}"
    );
    let unrecorded: Vec<&String> = implemented.difference(&recorded).collect();
    assert!(
        unrecorded.is_empty(),
        "Rust handlers with no corpus recording: {unrecorded:?}"
    );
}

#[tokio::test]
async fn every_implemented_command_replays() {
    // One child process per command: a replay leaves background tasks behind,
    // and a fresh process per command keeps every scenario isolated and the
    // comparison independent of earlier commands.
    let root = corpus_root();
    let binary = env!("CARGO_BIN_EXE_devboard-contract");
    let mut failures = Vec::new();
    for command in devboard::app::IMPLEMENTED_COMMANDS {
        let output = tokio::process::Command::new(binary)
            .args([
                "--corpus",
                root.to_str().expect("a UTF-8 corpus path"),
                "--play-command",
                command,
            ])
            .output()
            .await
            .expect("the replay child runs");
        if !output.status.success() {
            failures.push(format!(
                "{command}: {}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            ));
        }
    }
    assert!(failures.is_empty(), "divergences:\n{}", failures.join("\n"));
}

#[tokio::test]
async fn the_http_table_passes_against_the_rust_dashboard() {
    let root = corpus_root();
    // Its own directory: this test used to remove the whole `.test-work` root,
    // deleting the fixtures the other tests in this binary run against.
    let work = root.join(".test-work/http-table");
    let _ = std::fs::remove_dir_all(&work);
    let repo = work.join("repo");
    let state = work.join("state");
    devboard_contract::copy_dir(&root.join("fixtures/repo"), &repo).expect("a fixture repo");
    std::fs::create_dir_all(&state).expect("a fixture state");
    let mut config = dashboard_config(&repo, &state, &root.join("fixtures/static"));
    let listener = devboard::http::bind("127.0.0.1", 0)
        .await
        .expect("a listener");
    let port = listener.local_addr().expect("an address").port();
    config.port = port;
    let journal = Journal::open(&state, &repo, port);
    let server = Server::new(config, journal);
    let running = Arc::clone(&server);
    let handle = tokio::spawn(async move {
        let _ = devboard::http::serve_on(listener, running).await;
    });
    let base = format!("http://127.0.0.1:{port}");
    let results = http_table::run(&base).await;
    handle.abort();
    for result in &results {
        if let Err(error) = result {
            panic!("{error}");
        }
    }
    assert!(!results.is_empty());
}

#[test]
fn a_broken_fixture_makes_the_replay_fail() {
    // The replay must compare, not merely load. A fixture whose recorded pid
    // field has no allowlist entry and differs from the answer diverges.
    let temp = corpus_root().join(".test-work/broken-corpus");
    let _ = std::fs::remove_dir_all(&temp);
    std::fs::create_dir_all(temp.join("commands")).expect("a corpus");
    devboard_contract::copy_dir(&corpus_root().join("fixtures"), &temp.join("fixtures"))
        .expect("the shared fixtures");
    std::fs::write(
        temp.join("allowlist.json"),
        r#"{"fields":[{"name":"pid","reason":"the answering process id"}]}"#,
    )
    .expect("an allowlist");
    std::fs::write(
        temp.join("commands/getProject.json"),
        r#"{
  "command": "getProject",
  "scenarios": [
    {
      "name": "request",
      "send": "{\"type\":\"getProject\"}",
      "frames": [{"type": "project", "path": "definitely-not-the-project"}],
      "state": {}
    }
  ]
}
"#,
    )
    .expect("a recording");
    let corpus = devboard_contract::Corpus::load(&temp).expect("the broken corpus loads");
    let report = tokio::runtime::Runtime::new()
        .expect("a runtime")
        .block_on(devboard_contract::replay_all(&temp, &|_| true))
        .expect("the replay runs");
    assert!(
        !report.mismatches.is_empty(),
        "a broken fixture must diverge"
    );
    assert_eq!(corpus.commands.len(), 1);
}

#[test]
fn every_http_table_row_has_a_recording() {
    let root = corpus_root();
    let recorded: std::collections::BTreeSet<String> = devboard_contract::http_corpus::load(&root)
        .expect("the HTTP recordings load")
        .into_iter()
        .map(|case| case.name)
        .collect();
    let table: std::collections::BTreeSet<String> = http_table::cases()
        .into_iter()
        .map(|case| case.name.to_string())
        .collect();
    let missing: Vec<&String> = table.difference(&recorded).collect();
    assert!(
        missing.is_empty(),
        "table rows with no recording: {missing:?}"
    );
}

#[tokio::test]
async fn the_recorded_http_table_passes_against_the_rust_dashboard() {
    let root = corpus_root();
    let cases = devboard_contract::http_corpus::load(&root).expect("the HTTP recordings load");
    let corpus = devboard_contract::Corpus::load(&root).expect("the corpus loads");
    let work = root.join(".test-work/http");
    let _ = std::fs::remove_dir_all(&work);
    let repo = work.join("repo");
    let state = work.join("state");
    devboard_contract::copy_dir(&root.join("fixtures/repo"), &repo).expect("a fixture repo");
    std::fs::create_dir_all(&state).expect("a fixture state");
    let mut config = dashboard_config(&repo, &state, &root.join("fixtures/static"));
    let listener = devboard::http::bind("127.0.0.1", 0)
        .await
        .expect("a listener");
    let port = listener.local_addr().expect("an address").port();
    config.port = port;
    let journal = Journal::open(&state, &repo, port);
    let server = Server::new(config, journal);
    let handle = tokio::spawn(async move {
        let _ = devboard::http::serve_on(listener, server).await;
    });
    let base = format!("http://127.0.0.1:{port}");
    let failures =
        devboard_contract::http_corpus::replay(&base, &cases, &corpus.allowlist, &work).await;
    handle.abort();
    assert!(failures.is_empty(), "HTTP divergences: {failures:#?}");
}

#[tokio::test]
async fn flow_edge_frames_answer() {
    let root = corpus_root();
    let work = root.join(".test-work/flow-edge");
    let _ = std::fs::remove_dir_all(&work);
    let repo = work.join("repo");
    let state = work.join("state");
    devboard_contract::copy_dir(&root.join("fixtures/repo"), &repo).expect("a fixture repo");
    std::fs::create_dir_all(&state).expect("a fixture state");
    let mut config = dashboard_config(&repo, &state, &root.join("fixtures/static"));
    let listener = devboard::http::bind("127.0.0.1", 0)
        .await
        .expect("a listener");
    let port = listener.local_addr().expect("an address").port();
    config.port = port;
    let journal = Journal::open(&state, &repo, port);
    let server = Server::new(config, journal);
    let handle = tokio::spawn(async move {
        let _ = devboard::http::serve_on(listener, server).await;
    });
    let malformed = devboard_contract::drive_socket(port, "{\"type\":\"notAContractCommand\"}")
        .await
        .expect("malformed drives");
    assert_eq!(
        malformed,
        vec![serde_json::json!({"type": "error", "message": "Invalid WebSocket message."})]
    );
    let stop = devboard_contract::drive_socket(port, "{\"type\":\"stopFlowImplementation\"}")
        .await
        .expect("stop drives");
    assert_eq!(
        stop,
        vec![
            serde_json::json!({"type": "flowError", "message": "The Flow implementation is not running."})
        ]
    );
    handle.abort();
}
