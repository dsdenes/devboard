//! The HTTP table, its recorded answers, and the replay that proves them.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use devboard_contract::fixture::{
    allowlist_path, contract_dir, prepare_repository, repository_root, Fixture,
};
use devboard_contract::http_table::{self, Allowlist, Case, Corpus, Recording};
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

/// True when the table's replay of this route cannot name a live request: its
/// template resolved a placeholder to a fixture identity the installation does
/// not serve, or its command requires a value the body-less replay omits. Such
/// a row reaches the handler's own refusal, so its recording may be a 4xx.
fn names_no_live_request(case: &Case) -> bool {
    if case.request_path != case.path {
        return true;
    }
    let command = serde_json::json!({ "type": case.name });
    devboard::command::command_from_json(&command.to_string()).is_none()
}

/// Asserts a route row's recording is the route's answer. Only a row that
/// names no live request may record a refusal; a row that names a served path
/// with a complete request must record exactly its expected status, so a
/// re-record of a route that stopped matching cannot bless the 404.
fn assert_route_status(case: &Case, recording: &Recording) {
    assert!(
        recording.status == case.expect_status
            || ((400..500).contains(&recording.status) && names_no_live_request(case)),
        "{} records the route's {} or a refusal of a request that names no live resource, got {}",
        case.name,
        case.expect_status,
        recording.status
    );
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
            assert_route_status(case, recording);
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
fn a_recorded_refusal_fails_only_the_row_that_names_a_live_request() {
    let cases = http_table::all_cases();
    let case = |name: &str| {
        cases
            .iter()
            .find(|case| case.name == name)
            .unwrap_or_else(|| panic!("{name} has a row"))
    };
    let refusal = |case: &Case| Recording {
        name: case.name.to_string(),
        method: case.method.as_str().to_string(),
        path: case.path.to_string(),
        status: 404,
        body: serde_json::json!({ "type": "about:blank", "status": 404 }),
    };
    assert!(!names_no_live_request(case("getVersion")));
    assert!(names_no_live_request(case("acceptFlowWidget")));
    assert!(names_no_live_request(case("discoverRemote")));

    let failure = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        assert_route_status(case("getVersion"), &refusal(case("getVersion")))
    }))
    .expect_err("a refusal of a served path diverges");
    let message = failure
        .downcast_ref::<String>()
        .map(String::as_str)
        .unwrap_or_default();
    assert!(message.contains("getVersion"), "{message}");
    assert!(message.contains("records the route's 200"), "{message}");

    assert_route_status(case("acceptFlowWidget"), &refusal(case("acceptFlowWidget")));
    assert_route_status(case("discoverRemote"), &refusal(case("discoverRemote")));
}

#[test]
fn the_allowlist_names_every_field_it_excludes() {
    let allowlist = allowlist();
    assert!(!allowlist.is_empty(), "the allowlist is read");
    let mut seen = BTreeSet::new();
    for (name, at) in allowlist.entries() {
        assert!(!name.is_empty(), "every entry names a field");
        assert!(
            seen.insert((name.to_string(), at.map(str::to_string))),
            "{name} is listed twice at {at:?}"
        );
        assert!(
            allowlist.contains(name, at),
            "{name} is ignored at its own scope {at:?}"
        );
        assert!(
            !allowlist.contains(&format!("{name}_"), at),
            "{name} names one field, not a prefix"
        );
        if let Some(at) = at {
            assert!(!at.trim().is_empty(), "{name} names a non-empty parent key");
            assert!(
                !allowlist.contains(name, None),
                "{name} is ignored only under {at}, not at the body's top level"
            );
            assert!(
                !allowlist.contains(name, Some("anotherKey")),
                "{name} is ignored only under {at}"
            );
        } else {
            assert!(
                allowlist.contains(name, Some("anotherKey")),
                "{name} applies at every depth"
            );
        }
    }
}

/// The row whose answer carries the Discover state, with its recorded error
/// fields.
fn discover_row() -> http_table::Case {
    http_table::all_cases()
        .into_iter()
        .find(|case| case.name == "createFlowGoal")
        .expect("the Discover state row")
}

fn discover_state(body: &mut Value) -> &mut Value {
    body["frames"]
        .as_array_mut()
        .expect("the frames envelope")
        .iter_mut()
        .find(|frame| frame["type"] == "discoverState")
        .expect("a Discover state frame")
        .get_mut("state")
        .expect("the Discover state")
}

fn observed_body(name: &'static str, status: u16, body: &Value) -> http_table::Observed {
    http_table::Observed {
        name,
        status,
        headers: Default::default(),
        body: body.to_string(),
    }
}

#[test]
fn a_served_discover_error_diverges_where_the_recording_names_none() {
    let allowlist = allowlist();
    let case = discover_row();
    let recording = corpus()
        .get("createFlowGoal")
        .cloned()
        .expect("the createFlowGoal recording");
    let served = |body: &Value| observed_body(case.name, recording.status, body);
    http_table::check(&case, &recording, &allowlist, &served(&recording.body))
        .expect("the recorded answer replays");

    // The Discover prompt's ENOENT diagnostic is allowlisted at its own
    // location: it carries an absolute fixture path, so another text there is
    // ignored.
    let mut observed = recording.body.clone();
    discover_state(&mut observed)["agents"][0]["prompt"]["error"] = Value::String(
        "ENOENT: No such file or directory (os error 2): /abs/fixture/prompts/sheet.md".to_string(),
    );
    http_table::check(&case, &recording, &allowlist, &served(&observed))
        .expect("the prompt's ENOENT text names the fixture installation");

    // A read error the recording says is absent is compared at its own
    // location, so the corpus catches one appearing.
    for appear in [
        |state: &mut Value| state["error"] = Value::String("read_artifacts failed".to_string()),
        |state: &mut Value| {
            state["agents"][0]["error"] = Value::String("read_artifacts failed".to_string());
        },
    ] {
        let mut answer = recording.body.clone();
        appear(discover_state(&mut answer));
        let error = http_table::check(&case, &recording, &allowlist, &served(&answer))
            .expect_err("a served error where the recording names null diverges");
        assert!(error.contains(".error"), "{error}");
        assert!(!error.contains("prompt"), "{error}");
    }
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
async fn the_fixture_repository_names_its_own_origin_inside_a_foreign_checkout() {
    // The enclosing directory is a checkout whose origin names another
    // repository: a git command that walks up from the copied fixture
    // repository would answer with it.
    let root = scratch("foreign-checkout");
    for arguments in [
        ["init", "--quiet"].as_slice(),
        [
            "remote",
            "add",
            "origin",
            "https://git.example.test/other/host.git",
        ]
        .as_slice(),
    ] {
        let status = Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(arguments)
            .status()
            .expect("the enclosing checkout's git");
        assert!(status.success(), "git {}: {status}", arguments.join(" "));
    }
    let repo = root.join("repo");
    prepare_repository(&repo).expect("the fixture repository");
    let config = devboard::config::Config {
        hostname: "127.0.0.1".to_string(),
        port: 0,
        adrs_dir: repo.join("adrs"),
        repo_dir: repo.clone(),
        goal_file: repo.join("GOAL.md"),
        static_dir: None,
        agent_command: "true".to_string(),
        state_dir: root.join("state"),
        allowed_hosts: Vec::new(),
        feedback: None,
    };
    let fixture = Fixture::start_with(root, config)
        .await
        .expect("a dashboard");
    let case = http_table::all_cases()
        .into_iter()
        .find(|case| case.name == "getDiscover")
        .expect("the getDiscover row");
    let observed = http_table::send(&http_table::client(), &fixture.base, &case)
        .await
        .expect("the Discover answer");
    let body: Value = serde_json::from_str(&observed.body).expect("a JSON answer");
    let repository = body["frames"][0]["state"]["repository"].clone();
    assert_eq!(
        repository,
        Value::String("fixture/repo".to_string()),
        "the Discover state names the fixture's own repository"
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

/// The `getGoal` row derives the goal text from the installation's own
/// document. A document that exists but cannot be read fails that row, and is
/// never compared as the empty document a missing one derives.
#[tokio::test]
async fn the_live_goal_row_fails_when_the_document_exists_but_cannot_be_read() {
    let goal_file = scratch("unreadable").join("GOAL.md");
    std::fs::create_dir(&goal_file).expect("a goal path that cannot be read");
    let fixture = checkout_dashboard("unreadable", &goal_file).await;
    let installation = http_table::Installation {
        goal_file: goal_file.clone(),
        adrs_dir: repository_root().join("adrs"),
    };
    let results = http_table::run(&fixture.base, &corpus(), &allowlist(), &installation).await;
    let failures: Vec<&String> = results
        .iter()
        .filter_map(|result| result.as_ref().err())
        .collect();
    let goal_failure = failures
        .iter()
        .find(|error| error.starts_with("getGoal:"))
        .unwrap_or_else(|| panic!("the getGoal row failed: {failures:?}"));
    assert!(
        goal_failure.contains(&goal_file.display().to_string()),
        "{goal_failure}"
    );
}
