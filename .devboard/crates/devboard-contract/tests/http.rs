//! The HTTP table, its recorded answers, and the replay that proves them.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use devboard_contract::fixture::{allowlist_path, contract_dir, repository_root, Fixture};
use devboard_contract::http_table::{self, Allowlist, Corpus, Recording};
use serde_json::Value;

fn corpus() -> Corpus {
    Corpus::load(&contract_dir().join("http")).expect("the HTTP recordings")
}

fn allowlist() -> Allowlist {
    Allowlist::load(&allowlist_path()).expect("the nondeterminism allowlist")
}

/// One scratch directory inside the harness for one live check.
fn scratch(label: &str) -> PathBuf {
    let root = repository_root()
        .join(".devboard/.test-tmp")
        .join(format!("live-{label}-{}", std::process::id()));
    std::fs::create_dir_all(&root).expect("a scratch directory");
    root
}

/// One dashboard over this checkout: its goal document, its decision records,
/// and an empty state directory, the way an operator starts one from the
/// repository root.
async fn checkout_dashboard(label: &str, goal_file: &Path) -> Fixture {
    let root = scratch(label);
    let static_dir = root.join("static");
    std::fs::create_dir_all(&static_dir).expect("a static directory");
    let config = devboard::config::Config {
        hostname: "127.0.0.1".to_string(),
        port: 0,
        adrs_dir: repository_root().join("adrs"),
        repo_dir: repository_root(),
        goal_file: goal_file.to_path_buf(),
        static_dir: Some(static_dir),
        agent_command: "true".to_string(),
        state_dir: root.join("state"),
        allowed_hosts: Vec::new(),
        feedback: None,
    };
    Fixture::start_with(root, config)
        .await
        .expect("a dashboard")
}

/// Runs `--compare-http` the way an operator does, against one listener. The
/// child runs on a blocking thread so the in-process dashboard keeps serving
/// while it waits.
async fn compare(port: u16) -> Output {
    tokio::task::spawn_blocking(move || {
        let port = port.to_string();
        Command::new(env!("CARGO_BIN_EXE_devboard-contract"))
            .args(["--compare-http", port.as_str()])
            .arg("--contract")
            .arg(contract_dir())
            .output()
            .expect("the comparison runs")
    })
    .await
    .expect("the comparison task")
}

fn port_of(base: &str) -> u16 {
    base.rsplit(':')
        .next()
        .and_then(|port| port.parse().ok())
        .expect("the listener port")
}

/// The recorded answer of a served operation: the frames envelope of a
/// success, or the Problem document of a refusal.
fn assert_operation_answer(name: &str, recording: &Recording) {
    let object = recording
        .body
        .as_object()
        .unwrap_or_else(|| panic!("{name} records a JSON answer, got {}", recording.body));
    if (200..300).contains(&recording.status) {
        assert!(
            object.get("frames").and_then(Value::as_array).is_some(),
            "{name} records the frames envelope, got {}",
            recording.body
        );
        return;
    }
    assert_eq!(
        object.get("status").and_then(Value::as_u64),
        Some(u64::from(recording.status)),
        "{name} records its refusal status"
    );
}

#[test]
fn every_http_table_row_has_a_recording() {
    let corpus = corpus();
    let cases = http_table::all_cases();
    let routes: BTreeSet<&str> = http_table::route_cases()
        .iter()
        .map(|case| case.name)
        .collect();
    let mut names = BTreeSet::new();
    for case in &cases {
        assert!(names.insert(case.name), "one row per name: {}", case.name);
        let recording = corpus
            .get(case.name)
            .unwrap_or_else(|| panic!("{} has a recording", case.name));
        assert_eq!(recording.method, case.method.as_str());
        assert_eq!(recording.path, case.path);
        assert_eq!(
            case.request_path == case.path,
            !case.path.contains('{'),
            "{} resolves every placeholder to a fixture identity",
            case.name
        );
        if routes.contains(case.name) {
            assert_operation_answer(case.name, recording);
            assert!(
                recording.status == case.expect_status || (400..500).contains(&recording.status),
                "{} records the route's {} or a refusal, got {}",
                case.name,
                case.expect_status,
                recording.status
            );
        } else {
            assert_eq!(
                recording.status, case.expect_status,
                "{} records the row's status",
                case.name
            );
        }
    }
    assert_eq!(corpus.len(), cases.len(), "no extra recording");
    for name in corpus.names() {
        assert!(names.contains(name), "{name} has a table row");
    }
}

#[test]
fn the_allowlist_names_every_field_it_excludes() {
    let allowlist = allowlist();
    assert!(!allowlist.is_empty(), "the allowlist is read");
}

#[tokio::test]
async fn a_dropped_fixture_removes_its_root() {
    let fixture = Fixture::start("dropped").await.expect("a fixture");
    let root = fixture.root().to_path_buf();
    assert!(
        root.is_dir(),
        "the fixture root exists while the fixture lives: {}",
        root.display()
    );
    drop(fixture);
    assert!(
        !root.exists(),
        "the dropped fixture removed its root: {}",
        root.display()
    );
}

#[tokio::test]
async fn every_http_row_replays_against_the_fixture() {
    let corpus = corpus();
    let allowlist = allowlist();
    let results = devboard_contract::fixture::replay(&corpus, &allowlist)
        .await
        .expect("a fixture replay");
    let failures: Vec<String> = results
        .iter()
        .filter_map(|(name, result)| {
            result
                .as_ref()
                .err()
                .map(|error| format!("{name}: {error}"))
        })
        .collect();
    assert!(
        failures.is_empty(),
        "{} HTTP rows diverged:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[tokio::test]
async fn the_live_table_passes_against_a_dashboard_over_this_checkout() {
    let goal_file = repository_root().join("GOAL.md");
    let fixture = checkout_dashboard("pass", &goal_file).await;
    let output = compare(port_of(&fixture.base)).await;
    assert_eq!(
        output.status.code(),
        Some(0),
        "stderr:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("the live HTTP table passed"), "{stdout}");
    assert!(stdout.contains("GOAL.md"), "{stdout}");
    assert!(stdout.contains("adrs"), "{stdout}");
}

#[tokio::test]
async fn the_live_table_fails_when_the_served_goal_changed_by_one_byte() {
    // The served answer is this checkout's goal document with one byte
    // changed. A fresh worktree carries none (it is host data), so the served
    // document is then one the comparison cannot derive at all, which is the
    // same divergence.
    let mut bytes = std::fs::read(repository_root().join("GOAL.md")).unwrap_or_default();
    if bytes.is_empty() {
        bytes = b"a".to_vec();
    }
    let at = bytes
        .iter()
        .position(u8::is_ascii_alphabetic)
        .expect("the goal document carries a letter");
    bytes[at] = if bytes[at] == b'A' { b'B' } else { b'A' };
    let goal_file = scratch("changed").join("GOAL.md");
    std::fs::write(&goal_file, &bytes).expect("the changed goal document");
    let fixture = checkout_dashboard("changed", &goal_file).await;
    let output = compare(port_of(&fixture.base)).await;
    assert_eq!(
        output.status.code(),
        Some(1),
        "stdout:\n{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("FAIL getGoal"), "{stderr}");
    assert!(stderr.contains("differs from"), "{stderr}");
    assert!(stderr.contains("GOAL.md"), "{stderr}");
}
