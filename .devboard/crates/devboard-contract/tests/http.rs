//! The HTTP table, its recorded answers, and the replay that proves them.

use std::collections::BTreeSet;

use devboard_contract::fixture::{allowlist_path, contract_dir, Fixture};
use devboard_contract::http_table::{self, Allowlist, Corpus, Recording};
use serde_json::Value;

fn corpus() -> Corpus {
    Corpus::load(&contract_dir().join("http")).expect("the HTTP recordings")
}

fn allowlist() -> Allowlist {
    Allowlist::load(&allowlist_path()).expect("the nondeterminism allowlist")
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
