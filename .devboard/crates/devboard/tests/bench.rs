//! The runs-view benchmark measures one dashboard serving the shipped page: it
//! opens no `/agent-runs` request and no per-run output socket of its own.

use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

/// A fresh directory under the harness scratch root.
fn scratch(label: &str) -> PathBuf {
    let harness = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the devboard harness directory exists");
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock is after the epoch")
        .as_nanos();
    let root = harness
        .join(".test-tmp")
        .join(format!("bench-{label}-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&root).expect("a scratch directory");
    root
}

/// The scenario's whole warmup and measurement window issues no run read.
#[test]
fn the_runs_view_scenario_opens_no_agent_runs_read() {
    let root = scratch("runs-view-requests");
    let log = root.join("requests.log");
    let output = Command::new(env!("CARGO_BIN_EXE_devboard"))
        .args([
            "bench",
            "cpu",
            "--scenario",
            "runs-view",
            "--seconds",
            "1",
            "--json",
        ])
        .env("DEVBOARD_ACCESS_LOG", &log)
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")))
        .output()
        .expect("the bench command runs");
    assert!(
        output.status.success(),
        "the bench failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).expect("one JSON report");
    assert_eq!(report["scenario"], json!("runs-view"));

    let requests = std::fs::read_to_string(&log).expect("the scratch dashboard's request log");
    assert!(
        requests.lines().any(|line| line.ends_with(" /ready")),
        "the request log records the startup probe: {requests}"
    );
    let run_reads: Vec<&str> = requests
        .lines()
        .filter(|line| {
            line.split_once(' ').is_some_and(|(_method, path)| {
                path == "/agent-runs" || path.starts_with("/agent-runs/")
            })
        })
        .collect();
    assert!(
        run_reads.is_empty(),
        "the scenario opened the run reads {run_reads:?}: {requests}"
    );

    let _ = std::fs::remove_dir_all(&root);
}
