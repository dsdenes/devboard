//! The release suite CLI against real fixture workspaces.
//!
//! Each fixture is a tiny crate with its own git repository under
//! `.test-tmp/`. The CLI runs `cargo test --workspace` there once, retries each
//! failing test alone, classifies it flaky or deterministic, and files one
//! issue per finding in a stub Gitea instance. Every run leaves
//! `git status --porcelain` empty and the fixture sources byte-identical.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::State;
use axum::response::Response;
use axum::routing::any;
use serde_json::{json, Value};

// ---------------------------------------------------------------------------
// Fixtures

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("the harness workspace root")
        .to_path_buf()
}

struct Scratch {
    root: PathBuf,
}

impl Scratch {
    fn new(label: &str) -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let root = workspace_root()
            .join(".test-tmp")
            .join(format!("release-suite-{label}-{stamp}"));
        fs::create_dir_all(&root).expect("a scratch directory");
        Self { root }
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn git(directory: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(directory)
        .output()
        .expect("a git command");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn fixture_git(directory: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(directory)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).to_string())
}

struct Fixture {
    scratch: Scratch,
}

impl Fixture {
    fn new(label: &str, source: &str) -> Self {
        let scratch = Scratch::new(label);
        fs::create_dir_all(scratch.root.join("src")).expect("a source tree");
        fs::write(
            scratch.root.join("Cargo.toml"),
            format!(
                "[package]\nname = \"{label}\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[workspace]\n"
            ),
        )
        .expect("a manifest");
        fs::write(scratch.root.join("src/lib.rs"), source).expect("a suite source");
        fs::write(scratch.root.join(".gitignore"), "/target/\n/Cargo.lock\n")
            .expect("a fixture ignore file");
        git(&scratch.root, &["init", "-q"]);
        git(&scratch.root, &["add", "-A"]);
        git(
            &scratch.root,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@devboard.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-q",
                "-m",
                "test: the fixture",
            ],
        );
        Self { scratch }
    }

    fn root(&self) -> &Path {
        &self.scratch.root
    }

    fn origin(&self, base: &str) {
        git(
            self.root(),
            &["remote", "add", "origin", &format!("{base}/owner/name.git")],
        );
    }

    fn status(&self) -> String {
        fixture_git(self.root(), &["status", "--porcelain"]).expect("a fixture status")
    }

    fn source(&self) -> String {
        fs::read_to_string(self.root().join("src/lib.rs")).expect("the fixture source")
    }

    fn head(&self) -> String {
        fixture_git(self.root(), &["rev-parse", "HEAD"])
            .expect("a fixture commit")
            .trim()
            .to_string()
    }
}

// ---------------------------------------------------------------------------
// Stub forge

#[derive(Clone, Debug)]
struct StubIssue {
    number: i64,
    title: String,
    body: String,
    comments: Vec<String>,
}

#[derive(Clone)]
struct StubState {
    base: String,
    issues: Arc<Mutex<Vec<StubIssue>>>,
    requests: Arc<Mutex<Vec<(String, String)>>>,
}

async fn stub_entry(State(state): State<StubState>, request: axum::extract::Request) -> Response {
    let method = request.method().as_str().to_string();
    let path = request.uri().path().to_string();
    let body = axum::body::to_bytes(request.into_body(), usize::MAX)
        .await
        .unwrap_or_default()
        .to_vec();
    state
        .requests
        .lock()
        .expect("requests")
        .push((method.clone(), path.clone()));

    if method == "GET" && path.ends_with("/issues") {
        let issues: Vec<Value> = state
            .issues
            .lock()
            .expect("issues")
            .iter()
            .map(|issue| {
                json!({
                    "number": issue.number,
                    "title": issue.title,
                    "body": issue.body,
                    "state": "open",
                    "html_url": format!("{}/owner/name/issues/{}", state.base, issue.number),
                    "created_at": "2026-11-04T00:00:00Z",
                })
            })
            .collect();
        return json_response(Value::Array(issues));
    }
    if method == "POST" && path.ends_with("/issues") {
        let parsed: Value = serde_json::from_slice(&body).unwrap_or_else(|_| json!({}));
        let title = parsed
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let issue_body = parsed
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let mut issues = state.issues.lock().expect("issues");
        let number = issues.len() as i64 + 1;
        issues.push(StubIssue {
            number,
            title: title.clone(),
            body: issue_body,
            comments: Vec::new(),
        });
        return json_response(json!({
            "number": number,
            "title": title,
            "html_url": format!("{}/owner/name/issues/{number}", state.base),
            "created_at": "2026-11-04T00:00:00Z",
            "state": "open",
        }));
    }
    if method == "POST" && path.ends_with("/comments") {
        let number = path
            .trim_end_matches("/comments")
            .rsplit('/')
            .next()
            .and_then(|segment| segment.parse::<i64>().ok())
            .unwrap_or(0);
        let parsed: Value = serde_json::from_slice(&body).unwrap_or_else(|_| json!({}));
        let comment = parsed
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if let Some(issue) = state
            .issues
            .lock()
            .expect("issues")
            .iter_mut()
            .find(|issue| issue.number == number)
        {
            issue.comments.push(comment);
        }
        return json_response(json!({"id": 1}));
    }
    Response::builder()
        .status(404)
        .header("content-type", "application/json")
        .body(axum::body::Body::from(
            json!({"message": "not found"}).to_string(),
        ))
        .expect("a stub response")
}

fn json_response(value: Value) -> Response {
    Response::builder()
        .status(200)
        .header("content-type", "application/json")
        .body(axum::body::Body::from(value.to_string()))
        .expect("a stub response")
}

struct StubForge {
    base: String,
    state: StubState,
    handle: tokio::task::JoinHandle<()>,
}

impl StubForge {
    async fn start() -> Self {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("a stub listener");
        let port = listener.local_addr().expect("an address").port();
        let state = StubState {
            base: format!("http://127.0.0.1:{port}"),
            issues: Arc::new(Mutex::new(Vec::new())),
            requests: Arc::new(Mutex::new(Vec::new())),
        };
        let app = axum::Router::new()
            .fallback(any(stub_entry))
            .with_state(state.clone());
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self {
            base: state.base.clone(),
            state,
            handle,
        }
    }

    fn issues(&self) -> Vec<StubIssue> {
        self.state.issues.lock().expect("issues").clone()
    }

    fn requests(&self) -> Vec<(String, String)> {
        self.state.requests.lock().expect("requests").clone()
    }
}

impl Drop for StubForge {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

// ---------------------------------------------------------------------------
// CLI

/// One blocking CLI invocation; the test runtime keeps serving the stub.
fn run_cli(directory: &Path, environment: &[(String, String)]) -> (i32, String) {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_string());
    let output = Command::new(cargo)
        .args([
            "run",
            "--quiet",
            "-p",
            "devboard",
            "--",
            "release-suite",
            "--dir",
        ])
        .arg(directory)
        .current_dir(workspace_root())
        .envs(environment.iter().cloned())
        .output()
        .expect("the devboard binary");
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    (output.status.code().unwrap_or(-1), text)
}

async fn cli(directory: &Path, environment: Vec<(String, String)>) -> (i32, String) {
    let directory = directory.to_path_buf();
    tokio::task::spawn_blocking(move || run_cli(&directory, &environment))
        .await
        .expect("the CLI task")
}

fn forge_environment(forge: &StubForge, marker: Option<&Path>) -> Vec<(String, String)> {
    let mut environment = vec![
        ("DEVBOARD_GITEA_URL".to_string(), forge.base.clone()),
        ("DEVBOARD_GITEA_TOKEN".to_string(), "fixture".to_string()),
        (
            "GITHUB_SERVER_URL".to_string(),
            "http://forge.test".to_string(),
        ),
        (
            "GITHUB_REPOSITORY".to_string(),
            "dsdenes/devboard".to_string(),
        ),
        ("GITHUB_RUN_ID".to_string(), "77".to_string()),
    ];
    if let Some(marker) = marker {
        environment.push((
            "RELEASE_SUITE_FIXTURE_MARKER".to_string(),
            marker.to_string_lossy().into_owned(),
        ));
    }
    environment
}

fn persistent_failure_source() -> &'static str {
    "\
pub fn add(left: i32, right: i32) -> i32 {
    left + right
}

#[cfg(test)]
mod tests {
    #[test]
    fn always_fails() {
        assert_eq!(super::add(1, 1), 3, \"the fixture always fails\");
    }

    #[test]
    fn always_passes() {
        assert_eq!(super::add(1, 1), 2);
    }
}
"
}

fn transient_failure_source() -> &'static str {
    "\
pub fn ready() -> bool {
    true
}

#[cfg(test)]
mod tests {
    #[test]
    fn fails_once_then_passes() {
        let marker = std::env::var(\"RELEASE_SUITE_FIXTURE_MARKER\")
            .expect(\"the marker path\");
        let seen = std::fs::metadata(&marker).is_ok();
        if !seen {
            std::fs::write(&marker, \"seen\").expect(\"the marker\");
        }
        assert!(seen, \"the fixture fails its first attempt\");
        assert!(super::ready());
    }
}
"
}

fn compile_error_source() -> &'static str {
    "\
pub fn broken() -> i32 {
    missing_value + 1
}
"
}

// ---------------------------------------------------------------------------
// Tests

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn release_suite_blocks_a_deterministic_failure_and_files_one_issue() {
    let fixture = Fixture::new("always-failing", persistent_failure_source());
    let forge = StubForge::start().await;
    fixture.origin(&forge.base);
    let source = fixture.source();
    let commit = fixture.head();
    let environment = forge_environment(&forge, None);

    let (code, report) = cli(fixture.root(), environment.clone()).await;
    assert_ne!(
        code, 0,
        "a deterministic failure blocks the release: {report}"
    );
    assert!(
        report.contains("attempt 1/9: 1 fail, 1 pass, 0 skip"),
        "{report}"
    );
    assert!(
        report.contains("deterministic: src/lib.rs :: tests::always_fails"),
        "{report}"
    );
    assert!(
        report.contains("release suite: 1 attempt(s), 0 flaky, 1 deterministic, 1 fail"),
        "{report}"
    );
    assert!(
        report.contains("filed issue #1: deterministic(test): tests::always_fails"),
        "{report}"
    );
    assert!(
        !report.contains("skipped for the rest of this run"),
        "a deterministic test is never skipped: {report}"
    );
    assert_eq!(fixture.status(), "");
    assert_eq!(fixture.source(), source);

    let issues = forge.issues();
    assert_eq!(issues.len(), 1, "{issues:?}");
    let issue = &issues[0];
    assert!(
        issue
            .title
            .contains("deterministic(test): tests::always_fails"),
        "{}",
        issue.title
    );
    assert!(issue.title.chars().count() <= 200, "{}", issue.title);
    assert!(issue.body.contains("src/lib.rs"), "{}", issue.body);
    assert!(issue.body.contains("tests::always_fails"), "{}", issue.body);
    assert!(
        issue.body.contains("the fixture always fails"),
        "{}",
        issue.body
    );
    assert!(issue.body.contains(&commit), "{}", issue.body);
    assert!(
        issue
            .body
            .contains("http://forge.test/dsdenes/devboard/actions/runs/77"),
        "{}",
        issue.body
    );
    assert_eq!(
        issue.body.matches("### whole-suite attempt").count(),
        1,
        "{}",
        issue.body
    );
    assert_eq!(
        issue.body.matches("### isolated retry").count(),
        1,
        "{}",
        issue.body
    );
    assert!(
        issue.body.contains("failed its isolated retry"),
        "{}",
        issue.body
    );

    // A later finding for the same test appends exactly one comment and never
    // creates a second issue.
    let (second_code, second_report) = cli(fixture.root(), environment).await;
    assert_ne!(second_code, 0, "{second_report}");
    assert!(
        second_report.contains("commented on issue #1"),
        "{second_report}"
    );
    assert!(!second_report.contains("filed issue #2"), "{second_report}");
    let issues = forge.issues();
    assert_eq!(issues.len(), 1, "{issues:?}");
    assert_eq!(issues[0].comments.len(), 1);
    assert!(
        issues[0].comments[0].contains("http://forge.test/dsdenes/devboard/actions/runs/77"),
        "{}",
        issues[0].comments[0]
    );
    assert_eq!(fixture.status(), "");
    assert_eq!(fixture.source(), source);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn release_suite_classifies_a_flaky_failure_and_files_one_issue() {
    let fixture = Fixture::new("once-failing", transient_failure_source());
    let forge = StubForge::start().await;
    fixture.origin(&forge.base);
    let source = fixture.source();
    let marker = workspace_root()
        .join(".test-tmp")
        .join(format!("release-suite-marker-{}", std::process::id()));
    let _ = fs::remove_file(&marker);
    let environment = forge_environment(&forge, Some(&marker));

    let (code, report) = cli(fixture.root(), environment.clone()).await;
    assert_eq!(
        code, 0,
        "a flaky failure does not block the release: {report}"
    );
    assert!(
        report.contains("attempt 1/9: 1 fail, 0 pass, 0 skip"),
        "{report}"
    );
    assert!(
        report.contains("flaky: src/lib.rs :: tests::fails_once_then_passes"),
        "{report}"
    );
    assert!(
        report.contains("skipped for the rest of this run: tests::fails_once_then_passes"),
        "{report}"
    );
    assert!(
        report.contains("release suite: 1 attempt(s), 1 flaky, 0 deterministic, 0 fail"),
        "{report}"
    );
    assert!(
        report.contains("filed issue #1: flaky(test): tests::fails_once_then_passes"),
        "{report}"
    );
    assert_eq!(fixture.status(), "");
    assert_eq!(fixture.source(), source);

    let issues = forge.issues();
    assert_eq!(issues.len(), 1, "{issues:?}");
    assert!(
        issues[0]
            .title
            .contains("flaky(test): tests::fails_once_then_passes"),
        "{}",
        issues[0].title
    );
    assert!(
        issues[0].body.contains("passed its isolated retry"),
        "{}",
        issues[0].body
    );
    assert!(
        issues[0]
            .body
            .contains("the fixture fails its first attempt"),
        "{}",
        issues[0].body
    );

    // The skip is run-only: a second run on a fresh failure executes the test
    // again instead of reading the open issue as a skip list.
    let _ = fs::remove_file(&marker);
    let (second_code, second_report) = cli(fixture.root(), environment).await;
    let _ = fs::remove_file(&marker);
    assert_eq!(second_code, 0, "{second_report}");
    assert!(
        second_report.contains("attempt 1/9: 1 fail, 0 pass, 0 skip"),
        "the test executes again despite its open flaky issue: {second_report}"
    );
    assert!(
        second_report.contains("flaky: src/lib.rs :: tests::fails_once_then_passes"),
        "{second_report}"
    );
    assert!(
        second_report.contains("commented on issue #1"),
        "{second_report}"
    );
    assert!(!second_report.contains("filed issue #2"), "{second_report}");
    assert_eq!(forge.issues().len(), 1);
    assert_eq!(fixture.status(), "");
    assert_eq!(fixture.source(), source);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn release_suite_fails_structurally_on_a_compile_error() {
    let fixture = Fixture::new("compile-error", compile_error_source());
    let forge = StubForge::start().await;
    fixture.origin(&forge.base);
    let source = fixture.source();
    let environment = forge_environment(&forge, None);

    let (code, report) = cli(fixture.root(), environment).await;
    assert_ne!(code, 0, "{report}");
    assert!(report.contains("structural failure"), "{report}");
    assert!(report.contains("error[E0425]"), "{report}");
    assert!(
        report.contains("cannot find value `missing_value`"),
        "{report}"
    );
    assert!(report.contains("nothing was filed"), "{report}");
    assert_eq!(fixture.status(), "");
    assert_eq!(fixture.source(), source);
    assert!(forge.issues().is_empty(), "{:?}", forge.issues());
    assert!(
        !forge.requests().iter().any(|(method, _)| method == "POST"),
        "{:?}",
        forge.requests()
    );
}

// ---------------------------------------------------------------------------
// Build lease

struct RecordingRunner {
    seen: Arc<Mutex<Vec<devboard::publish::CommandInvocation>>>,
}

impl devboard::publish::CommandRunner for RecordingRunner {
    fn run<'a>(
        &'a self,
        invocation: devboard::publish::CommandInvocation,
    ) -> devboard::release_suite::BoxFuture<'a, devboard::publish::CommandOutcome> {
        Box::pin(async move {
            self.seen.lock().expect("invocations").push(invocation);
            devboard::publish::CommandOutcome {
                code: 0,
                stdout:
                    "running 1 test\ntest fixture::passes ... ok\ntest result: ok. 1 passed; 0 \
failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n"
                        .to_string(),
                stderr: "     Running unittests src/lib.rs \
(target/debug/deps/fixture-0000000000000000)\n"
                    .to_string(),
            }
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn release_suite_takes_the_shared_build_lease_with_the_derived_jobs() {
    let scratch = Scratch::new("build-lease");
    let suite = scratch.root.join("suite");
    fs::create_dir_all(&suite).expect("the suite directory");
    let state = scratch.root.join("state");
    let environment: devboard::forge::Environment = [
        ("STATE_DIR", state.to_string_lossy().into_owned()),
        ("DEVBOARD_MAX_BUILDS", "1".to_string()),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_string(), value))
    .collect();

    let lane = devboard::build_lane::BuildLane::new(
        state.join(devboard::build_lane::BUILD_LANE_DIRECTORY),
        1,
    );
    let held = lane.acquire();
    let seen: Arc<Mutex<Vec<devboard::publish::CommandInvocation>>> =
        Arc::new(Mutex::new(Vec::new()));
    let mut options = devboard::release_suite::ReleaseSuiteOptions::new(&suite);
    options.environment = environment;
    options.runner = Some(Arc::new(RecordingRunner {
        seen: Arc::clone(&seen),
    }));
    options.log = Some(Arc::new(|_: &str| {}));
    options.max_attempts = 1;
    options.file_issues = false;
    options.attempt_timeout = std::time::Duration::from_secs(60);

    let running = tokio::spawn(devboard::release_suite::run_suite(options));
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    assert!(
        seen.lock().expect("invocations").is_empty(),
        "the suite's cargo invocation ran while the lane was full"
    );
    drop(held);

    let report = running.await.expect("the suite task").expect("a report");
    assert_eq!(report.code, 0, "{report:?}");
    let invocations = seen.lock().expect("invocations").clone();
    assert_eq!(invocations.len(), 1, "{invocations:?}");
    let invocation = &invocations[0];
    assert_eq!(invocation.program, "cargo");
    assert_eq!(
        invocation.args,
        vec![
            "test".to_string(),
            "--workspace".to_string(),
            "--no-fail-fast".to_string()
        ]
    );
    assert_eq!(
        invocation
            .env
            .get("DEVBOARD_BUILD_SLOT")
            .map(String::as_str),
        Some("0")
    );
    let jobs = devboard::build_lane::jobs(devboard::build_lane::cpu_count(), 1).to_string();
    assert_eq!(
        invocation.env.get("CARGO_BUILD_JOBS").map(String::as_str),
        Some(jobs.as_str())
    );
}
