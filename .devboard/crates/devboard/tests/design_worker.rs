//! The Design System worker: one audited cycle, its staged documents and
//! release request, the exact state files, the filing caps and settings, the
//! checkout lock, drain, and the TypeScript exit codes.
//!
//! Every fixture is a real checkout under `.test-tmp`; the forge, the audit
//! turn, and the documentation release are injected, so no test contacts a
//! network or spawns an agent.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use devboard::workers::design::{
    capacity_for, design_config, preflight_design, release_documents, versioned_control_directory,
    versioned_lock_path, versioned_state_path, write_command, AuditSignal, AuditTurn,
    DesignCommand, DesignConfig, DesignForge, DesignForgeIssue, DesignLimits,
    DesignPreflightOptions, DesignPreflightResult, DesignSyncState, DesignWorker,
    DesignWorkerOptions, ForgeFuture, ForgeIssueState, ForgeRelease, ReleaseDocument,
    ReleaseFuture, ReleaseInput, ReleaseOk, ReleaseResult,
};
use devboard::workers::WorkerInvocation;

const NOW: i64 = 1_773_000_000_000;

fn scratch_root(label: &str) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let index = COUNTER.fetch_add(1, Ordering::SeqCst);
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("design-{label}-{}-{index}", std::process::id()))
}

fn git(cwd: &Path, args: &[&str]) {
    let output = Command::new("git")
        .arg("-c")
        .arg("user.name=Design Fixture")
        .arg("-c")
        .arg("user.email=fixture@example.test")
        .arg("-c")
        .arg("commit.gpgsign=false")
        .arg("-c")
        .arg("init.defaultBranch=main")
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {} failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr).trim()
    );
}

struct Fixture {
    root: PathBuf,
    repo: PathBuf,
    state: PathBuf,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let root = scratch_root(label);
        let _ = std::fs::remove_dir_all(&root);
        let repo = root.join("repo");
        let state = repo.join(".devboard").join(".tmp").join("state");
        std::fs::create_dir_all(repo.join(".devboard/client")).expect("the client directory");
        std::fs::create_dir_all(repo.join("design")).expect("the token directory");
        std::fs::create_dir_all(&state).expect("the state directory");
        std::fs::write(
            repo.join(".devboard/client/index.html"),
            "<!doctype html>\n<div id=\"app\"></div>\n",
        )
        .expect("the index");
        std::fs::write(
            repo.join(".devboard/client/App.svelte"),
            "<script lang=\"ts\">\n  const accent = \"#58a6ff\";\n</script>\n<main>Hello</main>\n",
        )
        .expect("the source");
        std::fs::write(
            repo.join("DESIGN.md"),
            [
                "# Interface",
                "",
                "## Colors",
                "",
                "Use tokens for every color. The accent token is `#58a6ff`.",
                "",
                "## Design principles",
                "",
                "- One accent token governs emphasis.",
                "",
                "## UX principles",
                "",
                "- Every state carries a word.",
                "",
            ]
            .join("\n"),
        )
        .expect("the prose");
        std::fs::write(
            repo.join("design/tokens.json"),
            "{\n  \"color\": {\n    \"accent\": {\n      \"$type\": \"color\",\n      \"$value\": { \"hex\": \"#58a6ff\" }\n    }\n  }\n}\n",
        )
        .expect("the tokens");
        std::fs::write(repo.join("tracked.txt"), "original\n").expect("a tracked file");
        git(&repo, &["init", "-q"]);
        git(&repo, &["config", "user.email", "fixture@example.test"]);
        git(&repo, &["config", "user.name", "Design Fixture"]);
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-q", "-m", "fixture"]);
        Self { root, repo, state }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

struct FakeForge {
    issues: Mutex<Vec<DesignForgeIssue>>,
    open_title_calls: AtomicU64,
}

impl FakeForge {
    fn new(issues: Vec<DesignForgeIssue>) -> Arc<Self> {
        Arc::new(Self {
            issues: Mutex::new(issues),
            open_title_calls: AtomicU64::new(0),
        })
    }
}

fn issue(number: i64, title: &str, state: ForgeIssueState) -> DesignForgeIssue {
    DesignForgeIssue {
        number,
        title: title.to_string(),
        url: format!("https://forge.test/acme/fixture/issues/{number}"),
        state,
        created_at: "2026-01-10T10:00:00.000Z".to_string(),
        closed_at: None,
        body: "## Category\n\ncolor\n".to_string(),
    }
}

impl DesignForge for FakeForge {
    fn list_issues(&self) -> ForgeFuture<Vec<DesignForgeIssue>> {
        let issues = self.issues.lock().expect("the forge issues").clone();
        Box::pin(async move { Ok(issues) })
    }

    fn list_open_issue_titles(&self) -> ForgeFuture<Vec<String>> {
        self.open_title_calls.fetch_add(1, Ordering::SeqCst);
        let titles = self
            .issues
            .lock()
            .expect("the forge issues")
            .iter()
            .filter(|issue| issue.state == ForgeIssueState::Open)
            .map(|issue| issue.title.clone())
            .collect();
        Box::pin(async move { Ok(titles) })
    }

    fn list_releases(&self) -> ForgeFuture<Vec<ForgeRelease>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

struct Clock {
    now: AtomicI64,
}

impl Clock {
    fn new(now: i64) -> Arc<Self> {
        Arc::new(Self {
            now: AtomicI64::new(now),
        })
    }

    fn function(self: &Arc<Self>) -> Arc<dyn Fn() -> i64 + Send + Sync> {
        let clock = Arc::clone(self);
        Arc::new(move || clock.now.load(Ordering::SeqCst))
    }
}

fn options(fixture: &Fixture, clock: &Arc<Clock>) -> DesignWorkerOptions {
    let mut options = DesignWorkerOptions::new(&fixture.repo, &fixture.state);
    options.harness_version = Some("test".to_string());
    options.sync_ms = Some(10_000);
    options.cadence_ms = Some(60 * 60_000);
    options.tick_ms = Some(3_600_000);
    options.manual_cycles = true;
    options.now = Some(clock.function());
    options.argv = vec![
        "devboard".to_string(),
        "worker".to_string(),
        "design".to_string(),
    ];
    options
}

fn cycle_directories(repo: &Path) -> Vec<PathBuf> {
    let root = repo
        .join(".devboard")
        .join(".tmp")
        .join("design")
        .join("cycles");
    let mut paths: Vec<PathBuf> = std::fs::read_dir(&root)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path.is_dir())
                .collect()
        })
        .unwrap_or_default();
    paths.sort();
    paths
}

async fn wait_for<T, F>(read: F, description: &str) -> T
where
    F: Fn() -> Option<T>,
{
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(value) = read() {
            return value;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "timed out waiting for {description}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn write_json(path: &Path, value: &serde_json::Value) {
    std::fs::write(
        path,
        format!("{}\n", serde_json::to_string_pretty(value).unwrap()),
    )
    .expect("a JSON file");
}

#[tokio::test]
async fn one_cycle_stages_the_documents_and_records_the_release_request() {
    let fixture = Fixture::new("cycle");
    let forge = FakeForge::new(vec![issue(
        7,
        "Existing accent drift",
        ForgeIssueState::Open,
    )]);
    let clock = Clock::new(NOW);
    let releases = Arc::new(Mutex::new(Vec::<String>::new()));

    let mut worker_options = options(&fixture, &clock);
    worker_options.forge = Some(forge as Arc<dyn DesignForge>);
    let release_calls = Arc::clone(&releases);
    worker_options.release = Some(Arc::new(move |input: ReleaseInput| -> ReleaseFuture {
        let calls = Arc::clone(&release_calls);
        Box::pin(async move {
            calls
                .lock()
                .expect("the release calls")
                .push(input.summary.clone());
            assert!(input.documents[0].text.contains("- One accent token."));
            ReleaseResult::Ok(ReleaseOk {
                version: "0.1.42".to_string(),
                url: "https://forge.test/acme/fixture/releases/tag/v0.1.42".to_string(),
                sha: "abcdef1234567890".to_string(),
                branch: format!("design/{}", input.cycle_id),
                files: vec!["DESIGN.md".to_string(), "design/tokens.json".to_string()],
                diff: "--- a/DESIGN.md\n+++ b/DESIGN.md\n@@ -1 +1 @@\n-old\n+new\n".to_string(),
            })
        })
    }));
    worker_options.audit = Some(Arc::new(|turn: AuditTurn| {
        Box::pin(async move {
            let design = turn.directory.join("draft").join("DESIGN.md");
            let text = std::fs::read_to_string(&design).expect("the draft prose");
            std::fs::write(&design, format!("{text}\n- One accent token.\n")).expect("the draft");
            write_json(
                &turn.directory.join("release-request.json"),
                &serde_json::json!({
                    "version": 1,
                    "summary": "Document the accent standard",
                    "rationale": "Two surfaces share the token.",
                    "requestedAt": "2026-01-10T10:00:00.000Z",
                }),
            );
            std::fs::write(
                turn.directory.join("tool-log.jsonl"),
                "{\"tool\":\"issue_create\",\"ok\":true,\"value\":{\"number\":7,\"title\":\"Existing accent drift\",\"url\":\"https://forge.test/acme/fixture/issues/7\"}}\n",
            )
            .expect("the tool log");
            (turn.signal)(AuditSignal::Activity {
                text: "filed #7".to_string(),
                append: false,
            });
            Ok(())
        })
    }));

    let worker = DesignWorker::new(worker_options);
    assert!(worker.start("acme/fixture"));
    worker.refresh().await;
    assert_eq!(worker.current_state().sync.state, DesignSyncState::Ok);
    worker.begin_cycle().await;
    worker.wait_for_cycle().await;

    let state = worker.current_state();
    assert_eq!(
        state.lifecycle,
        devboard::workers::design::DesignLifecycle::Idle
    );
    assert_eq!(state.issues.len(), 1);
    assert_eq!(state.issues[0].number, 7);
    assert_eq!(state.issues[0].category.as_deref(), Some("color"));
    assert_eq!(
        state
            .release
            .as_ref()
            .map(|release| release.version.as_str()),
        Some("0.1.42")
    );
    assert_eq!(state.documentation.len(), 1);
    assert_eq!(
        state.documentation[0].summary,
        "Document the accent standard"
    );
    assert_eq!(
        state.documentation[0].files,
        vec!["DESIGN.md".to_string(), "design/tokens.json".to_string()]
    );
    assert_eq!(releases.lock().expect("the release calls").len(), 1);

    let directories = cycle_directories(&fixture.repo);
    assert_eq!(directories.len(), 1);
    let directory = &directories[0];
    let request: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(directory.join("request.json")).expect("the request"),
    )
    .expect("request JSON");
    assert_eq!(request["version"], 2);
    assert_eq!(request["sourceDir"], ".devboard/client");
    assert_eq!(
        request["documents"],
        serde_json::json!(["DESIGN.md", "design/tokens.json"])
    );
    assert_eq!(
        request["categories"].as_array().expect("categories").len(),
        6
    );
    assert_eq!(request["issueRoom"], 4);
    assert_eq!(
        request["knownTitles"],
        serde_json::json!(["Existing accent drift", "Existing accent drift"])
    );
    let entry_path = request["entryPoint"]["path"]
        .as_str()
        .expect("the entry point");
    assert!(entry_path.starts_with(".devboard/client/"));

    let input: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(directory.join("input.json")).expect("the input"),
    )
    .expect("input JSON");
    assert_eq!(input["documents"].as_array().expect("documents").len(), 2);
    assert!(input["sources"].as_array().expect("sources").len() >= 2);
    assert!(
        std::fs::read_to_string(directory.join("draft").join("DESIGN.md"))
            .expect("the draft")
            .contains("- One accent token.")
    );
    assert!(directory.join("release-request.json").is_file());
    assert!(!directory.join("audit.json").exists());
    let activity = std::fs::read_to_string(directory.join("activity.json")).expect("activity");
    assert!(activity.contains("entry point"));
    assert!(activity.contains("room 4"));
    assert!(activity.contains("filed #7"));
    assert!(activity.contains("pushed documentation abcdef1"));

    let persisted = std::fs::read_to_string(versioned_state_path(
        &fixture.state,
        &fixture.repo,
        Some("test"),
    ))
    .expect("the versioned state");
    let persisted: serde_json::Value = serde_json::from_str(&persisted).expect("state JSON");
    assert_eq!(persisted["version"], 1);
    assert_eq!(
        persisted["documentation"]
            .as_array()
            .expect("history")
            .len(),
        1
    );
    assert_eq!(persisted["worker"]["harnessVersion"], "test");

    worker.stop().await;
    assert!(!versioned_lock_path(&fixture.repo, Some("test")).exists());
    assert_eq!(
        worker.current_state().lifecycle,
        devboard::workers::design::DesignLifecycle::Stopped
    );
}

#[tokio::test]
async fn the_limits_gate_the_cycle_and_a_settings_command_persists() {
    let fixture = Fixture::new("capacity");
    let forge = FakeForge::new(vec![issue(
        3,
        "One open design issue",
        ForgeIssueState::Open,
    )]);
    let clock = Clock::new(NOW);
    std::fs::create_dir_all(devboard::workers::design::repo_state_directory(
        &fixture.state,
        &fixture.repo,
    ))
    .expect("the repository state directory");
    std::fs::write(
        devboard::workers::design::settings_path(&fixture.state, &fixture.repo),
        "{\n  \"maxPerHour\": 1,\n  \"maxPending\": 1,\n  \"intervalMinutes\": 60\n}\n",
    )
    .expect("the settings");

    let mut worker_options = options(&fixture, &clock);
    worker_options.forge = Some(forge as Arc<dyn DesignForge>);
    worker_options.release = Some(Arc::new(|_input: ReleaseInput| -> ReleaseFuture {
        Box::pin(async {
            ReleaseResult::Ok(ReleaseOk {
                version: "0.1.9".to_string(),
                url: "u".to_string(),
                sha: "a".to_string(),
                branch: "b".to_string(),
                files: Vec::new(),
                diff: String::new(),
            })
        })
    }));
    worker_options.audit = Some(Arc::new(|turn: AuditTurn| {
        Box::pin(async move {
            let request: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(turn.directory.join("request.json")).expect("request"),
            )
            .expect("request JSON");
            assert_eq!(request["issueRoom"], 0);
            Ok(())
        })
    }));

    let worker = DesignWorker::new(worker_options);
    assert!(worker.start("acme/fixture"));
    worker.refresh().await;
    worker.begin_cycle().await;
    worker.wait_for_cycle().await;
    let state = worker.current_state();
    assert_eq!(state.limits.max_per_hour, Some(1));
    assert_eq!(state.limits.max_pending, Some(1));
    assert_eq!(state.issues.len(), 1);
    let directory = cycle_directories(&fixture.repo).pop().expect("one cycle");
    assert!(!directory.join("tool-log.jsonl").exists());
    assert!(std::fs::read_to_string(directory.join("activity.json"))
        .expect("activity")
        .contains("room 0"));

    let control = versioned_control_directory(&fixture.state, &fixture.repo, Some("test"));
    write_command(
        &control,
        &DesignCommand::Settings {
            interval_minutes: 90,
            max_per_hour: Some(4),
            max_pending: None,
        },
    )
    .expect("the settings command");
    worker.tick_now().await;
    let state = worker.current_state();
    assert_eq!(state.interval_minutes, 90);
    assert_eq!(state.limits.max_per_hour, Some(4));
    assert_eq!(state.limits.max_pending, None);
    assert_eq!(state.notice.as_deref(), Some("Settings saved."));
    let persisted: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(devboard::workers::design::settings_path(
            &fixture.state,
            &fixture.repo,
        ))
        .expect("the settings file"),
    )
    .expect("settings JSON");
    assert_eq!(persisted["intervalMinutes"], 90);
    assert_eq!(persisted["maxPerHour"], 4);
    assert!(persisted["maxPending"].is_null());
    worker.stop().await;
}

#[tokio::test]
async fn the_periodic_read_leaves_open_titles_to_the_cycle() {
    let fixture = Fixture::new("titles");
    let forge = FakeForge::new(vec![issue(
        7,
        "Existing accent drift",
        ForgeIssueState::Open,
    )]);
    let clock = Clock::new(NOW);
    let seen = Arc::new(Mutex::new(serde_json::Value::Null));
    let seen_for_audit = Arc::clone(&seen);

    let mut worker_options = options(&fixture, &clock);
    worker_options.forge = Some(Arc::clone(&forge) as Arc<dyn DesignForge>);
    worker_options.audit = Some(Arc::new(move |turn: AuditTurn| {
        let seen = Arc::clone(&seen_for_audit);
        Box::pin(async move {
            let request: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(turn.directory.join("request.json")).expect("request"),
            )
            .expect("request JSON");
            *seen.lock().expect("the request") = request;
            Ok(())
        })
    }));

    let worker = DesignWorker::new(worker_options);
    assert!(worker.start("acme/fixture"));
    worker.refresh().await;
    // The periodic read never walks the open issue history.
    assert_eq!(forge.open_title_calls.load(Ordering::SeqCst), 0);
    // A title created after the sync is still in the cycle's duplicate check.
    forge.issues.lock().expect("the forge issues").push(issue(
        9,
        "Fresh open title",
        ForgeIssueState::Open,
    ));
    worker.begin_cycle().await;
    worker.wait_for_cycle().await;
    assert_eq!(forge.open_title_calls.load(Ordering::SeqCst), 1);
    let request = seen.lock().expect("the request").clone();
    let titles = request["knownTitles"].as_array().expect("known titles");
    assert!(
        titles.iter().any(|title| title == "Fresh open title"),
        "{titles:?}"
    );
    worker.stop().await;
}

#[tokio::test]
async fn drain_finishes_the_in_flight_cycle_then_releases_the_lock() {
    let fixture = Fixture::new("drain");
    let forge = FakeForge::new(Vec::new());
    let clock = Clock::new(NOW);
    let gate = Arc::new(tokio::sync::Notify::new());
    let audit_gate = Arc::clone(&gate);

    let mut worker_options = options(&fixture, &clock);
    worker_options.forge = Some(forge as Arc<dyn DesignForge>);
    worker_options.release = Some(Arc::new(|_input: ReleaseInput| -> ReleaseFuture {
        Box::pin(async {
            ReleaseResult::Ok(ReleaseOk {
                version: "0.1.9".to_string(),
                url: "u".to_string(),
                sha: "a".to_string(),
                branch: "b".to_string(),
                files: Vec::new(),
                diff: String::new(),
            })
        })
    }));
    worker_options.audit = Some(Arc::new(move |_turn: AuditTurn| {
        let gate = Arc::clone(&audit_gate);
        Box::pin(async move {
            gate.notified().await;
            Ok(())
        })
    }));

    let worker = DesignWorker::new(worker_options);
    assert!(worker.start("acme/fixture"));
    worker.refresh().await;
    worker.begin_cycle().await;
    wait_for(
        || (!cycle_directories(&fixture.repo).is_empty()).then_some(()),
        "the cycle directory",
    )
    .await;
    assert!(versioned_lock_path(&fixture.repo, Some("test")).exists());

    let control = versioned_control_directory(&fixture.state, &fixture.repo, Some("test"));
    write_command(&control, &DesignCommand::Drain).expect("the drain command");
    worker.tick_now().await;
    let draining = worker.current_state();
    assert!(draining.draining);
    assert_eq!(
        draining.notice.as_deref(),
        Some("Draining: this worker exits after its in-flight cycle.")
    );
    assert!(worker.cycling_now());
    assert!(versioned_lock_path(&fixture.repo, Some("test")).exists());

    gate.notify_one();
    worker.wait_for_cycle().await;
    let stopped = wait_for(
        || {
            let state = worker.current_state();
            (state.lifecycle == devboard::workers::design::DesignLifecycle::Stopped)
                .then_some(state)
        },
        "the drained worker",
    )
    .await;
    assert!(!stopped.enabled);
    assert_eq!(
        stopped.notice.as_deref(),
        Some("Drained: exited after its in-flight cycle.")
    );
    assert!(!versioned_lock_path(&fixture.repo, Some("test")).exists());
}

#[tokio::test]
async fn the_command_exits_with_the_typescript_codes() {
    let binary = env!("CARGO_BIN_EXE_devboard");
    let fixture = Fixture::new("no-origin");
    let no_origin = Command::new(binary)
        .args([
            "worker",
            "design",
            "--repo",
            fixture.repo.to_str().expect("a path"),
            "--state-dir",
            fixture.state.to_str().expect("a path"),
        ])
        .output()
        .expect("the binary runs");
    assert_eq!(no_origin.status.code(), Some(2));

    let duplicate = Fixture::new("duplicate");
    git(
        &duplicate.repo,
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/acme/fixture.git",
        ],
    );
    let lock = devboard::workers::design::acquire_lock(
        &versioned_lock_path(&duplicate.repo, Some("test")),
        &devboard::workers::design::LockDetails {
            repo: duplicate.repo.to_string_lossy().into_owned(),
            state_dir: duplicate.state.to_string_lossy().into_owned(),
            harness_version: Some("test".to_string()),
            argv: vec!["devboard".to_string()],
        },
    )
    .acquired()
    .expect("the fixture lock");
    let second = Command::new(binary)
        .args([
            "worker",
            "design",
            "--repo",
            duplicate.repo.to_str().expect("a path"),
            "--state-dir",
            duplicate.state.to_str().expect("a path"),
        ])
        .env("DEVBOARD_HARNESS_VERSION", "test")
        .output()
        .expect("the binary runs");
    assert_eq!(second.status.code(), Some(0));
    drop(lock);
}

fn git_stdout(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-c")
        .arg("user.name=Design Fixture")
        .arg("-c")
        .arg("user.email=fixture@example.test")
        .arg("-c")
        .arg("commit.gpgsign=false")
        .arg("-c")
        .arg("init.defaultBranch=main")
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("git runs");
    assert!(output.status.success(), "git {} failed", args.join(" "));
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

#[tokio::test]
async fn the_release_planner_commits_only_the_documents_and_cleans_up() {
    let fixture = Fixture::new("release");
    let origin = fixture.root.join("origin.git");
    git(
        &fixture.root,
        &["init", "--bare", "-q", origin.to_str().expect("a path")],
    );
    git(
        &fixture.repo,
        &["remote", "add", "origin", origin.to_str().expect("a path")],
    );
    git(&fixture.repo, &["push", "-q", "-u", "origin", "main"]);
    let design = std::fs::read_to_string(fixture.repo.join("DESIGN.md")).expect("the prose");
    let tokens =
        std::fs::read_to_string(fixture.repo.join("design/tokens.json")).expect("the tokens");
    let activity = Arc::new(Mutex::new(Vec::<String>::new()));
    let activity_sink = {
        let activity = Arc::clone(&activity);
        Arc::new(move |line: &str| {
            activity
                .lock()
                .expect("the release activity")
                .push(line.to_string());
        })
    };
    let environment: HashMap<String, String> = std::env::vars().collect();
    let result = release_documents(ReleaseInput {
        repo_dir: fixture.repo.clone(),
        harness_dir: fixture.repo.join(".devboard"),
        cycle_id: "cycle-1".to_string(),
        summary: "Document the accent standard".to_string(),
        config: design_config(&environment),
        documents: vec![
            ReleaseDocument {
                path: "DESIGN.md".to_string(),
                text: format!("{design}\n- One accent token.\n"),
            },
            ReleaseDocument {
                path: "design/tokens.json".to_string(),
                text: format!("{tokens}\n"),
            },
        ],
        environment,
        activity: activity_sink as Arc<dyn Fn(&str) + Send + Sync>,
    })
    .await;
    match result {
        ReleaseResult::Ok(released) => {
            assert_eq!(released.version, "1.0.0");
            assert!(released.url.contains(&format!("/commit/{}", released.sha)));
            assert_eq!(
                released.files,
                vec!["DESIGN.md".to_string(), "design/tokens.json".to_string()]
            );
            assert!(released.diff.contains("--- a/DESIGN.md"));
            assert!(released.diff.contains("+- One accent token."));
            let bare_head = git_stdout(&origin, &["rev-parse", "main"]);
            assert_eq!(bare_head, released.sha);
            let mut names: Vec<String> =
                git_stdout(&origin, &["show", "--name-only", "--format=", "main"])
                    .lines()
                    .map(str::to_string)
                    .collect();
            names.sort();
            assert_eq!(
                names,
                vec!["DESIGN.md".to_string(), "design/tokens.json".to_string()]
            );
        }
        ReleaseResult::Failed(failure) => {
            panic!("the release failed at {}: {}", failure.step, failure.detail)
        }
    }
    assert!(!fixture.repo.join(".worktree/design-cycle-1").exists());
    assert_eq!(
        git_stdout(&fixture.repo, &["branch", "--list", "design/cycle-1"]),
        ""
    );
    assert!(activity
        .lock()
        .expect("the release activity")
        .iter()
        .any(|line| line.contains("pushed documentation")));
}

#[test]
fn capacity_counts_the_window_and_the_smaller_room_wins() {
    let now = 1_767_268_800_000;
    let rows = vec![
        devboard::workers::design::DesignIssueRow {
            number: 1,
            title: "one".to_string(),
            url: "u1".to_string(),
            created_at: "2026-01-01T11:30:00.000Z".to_string(),
            state: devboard::workers::design::DesignIssueState::Implemented,
            category: Some("color".to_string()),
            version: None,
        },
        devboard::workers::design::DesignIssueRow {
            number: 2,
            title: "two".to_string(),
            url: "u2".to_string(),
            created_at: "2026-01-01T11:45:00.000Z".to_string(),
            state: devboard::workers::design::DesignIssueState::Pending,
            category: None,
            version: None,
        },
    ];
    let capacity = capacity_for(
        &rows,
        &DesignLimits {
            max_per_hour: Some(3),
            max_pending: Some(5),
        },
        now,
    );
    assert_eq!(capacity.window_count, 2);
    assert_eq!(capacity.hourly_room, 1);
    assert_eq!(capacity.batch, 1);
    let unlimited = capacity_for(
        &rows,
        &DesignLimits {
            max_per_hour: None,
            max_pending: None,
        },
        now,
    );
    assert_eq!(unlimited.batch, 100);
}

#[test]
fn the_fixture_configuration_is_the_default_design_layout() {
    let config = design_config(&HashMap::new());
    assert_eq!(config.source_dir, ".devboard/client");
    assert_eq!(config.design_document, "DESIGN.md");
    assert_eq!(config.token_document, "design/tokens.json");
}

#[tokio::test]
async fn design_preflight_needs_only_git_and_gh_and_keeps_its_refusals() {
    use std::os::unix::fs::PermissionsExt as _;

    let root = scratch_root("preflight");
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).expect("a fixture checkout");
    git(&repo, &["init", "--quiet"]);
    let write = |relative: &str, text: &str| {
        let path = repo.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).expect("a directory");
        std::fs::write(path, text).expect("a file");
    };
    write(".devboard/client/index.html", "<!doctype html>\n");
    write("DESIGN.md", "# Design\n");
    write("design/tokens.json", "{}\n");

    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).expect("a bin directory");
    let git_path = std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .map(|directory| Path::new(directory).join("git"))
        .find(|candidate| candidate.is_file())
        .expect("git on the fixture PATH");
    std::os::unix::fs::symlink(git_path, bin.join("git")).expect("a git link");
    let gh = bin.join("gh");
    std::fs::write(
        &gh,
        "#!/bin/sh\ncase \"$*\" in\n  *\"/labels/\"*) echo design ;;\n  *.permissions.push*) echo true ;;\n  *\"label create\"*) echo design ;;\n  *) echo \"\" ;;\nesac\n",
    )
    .expect("a gh stub");
    std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).expect("executable");
    let mut environment = HashMap::new();
    environment.insert("PATH".to_string(), bin.to_string_lossy().into_owned());

    let options = |origin: Option<devboard::forge::ForgeRemote>| DesignPreflightOptions {
        repo_dir: repo.clone(),
        state_dir: repo.join(".devboard").join(".tmp"),
        config: DesignConfig::default(),
        environment: environment.clone(),
        origin,
    };
    let github = devboard::forge::ForgeRemote {
        forge: devboard::forge::Forge::GitHub,
        host: "github.test".to_string(),
        project: "acme/fixture".to_string(),
        origin_url: None,
    };
    match preflight_design(options(Some(github.clone()))).await {
        DesignPreflightResult::Ok { repository } => assert_eq!(repository, "acme/fixture"),
        DesignPreflightResult::Refused { message } => panic!("refused: {message}"),
    }

    std::fs::remove_file(repo.join("design/tokens.json")).expect("remove");
    match preflight_design(options(Some(github.clone()))).await {
        DesignPreflightResult::Refused { message } => {
            assert!(message.contains("design/tokens.json"), "{message}")
        }
        DesignPreflightResult::Ok { .. } => panic!("a missing token document is accepted"),
    }
    write("design/tokens.json", "{}\n");

    std::fs::remove_file(repo.join("DESIGN.md")).expect("remove");
    match preflight_design(options(Some(github.clone()))).await {
        DesignPreflightResult::Refused { message } => {
            assert!(message.contains("DESIGN.md"), "{message}")
        }
        DesignPreflightResult::Ok { .. } => panic!("a missing design document is accepted"),
    }
    write("DESIGN.md", "# Design\n");

    std::fs::remove_file(repo.join(".devboard/client/index.html")).expect("remove");
    match preflight_design(options(Some(github.clone()))).await {
        DesignPreflightResult::Refused { message } => {
            assert!(message.contains("index.html"), "{message}")
        }
        DesignPreflightResult::Ok { .. } => panic!("a missing client entry is accepted"),
    }
    write(".devboard/client/index.html", "<!doctype html>\n");

    std::fs::remove_dir_all(repo.join(".devboard/client")).expect("remove");
    match preflight_design(options(Some(github.clone()))).await {
        DesignPreflightResult::Refused { message } => {
            assert!(message.contains(".devboard/client"), "{message}")
        }
        DesignPreflightResult::Ok { .. } => panic!("a missing client is accepted"),
    }
    write(".devboard/client/index.html", "<!doctype html>\n");

    let gitlab = devboard::forge::ForgeRemote {
        forge: devboard::forge::Forge::GitLab,
        host: "gitlab.test".to_string(),
        project: "acme/fixture".to_string(),
        origin_url: None,
    };
    match preflight_design(options(Some(gitlab))).await {
        DesignPreflightResult::Refused { message } => {
            assert!(message.contains("GitLab"), "{message}")
        }
        DesignPreflightResult::Ok { .. } => panic!("a GitLab origin is accepted"),
    }
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn an_invocation_parses_the_worker_flags() {
    let invocation = WorkerInvocation {
        family: "design".to_string(),
        repo_dir: PathBuf::from("repo"),
        state_dir: PathBuf::from("state"),
        rest: vec!["--sync".to_string(), "2000".to_string()],
        raw: vec!["design".to_string()],
    };
    assert_eq!(invocation.option("sync"), Some("2000"));
}

/* ------------------------------------------------------------------------ */
/* Cadence liveness and the inherited startup state                          */
/* ------------------------------------------------------------------------ */

/// The worker's ticks, on one thread and one runtime of their own, so a gate that
/// never returns fails the test within its bound instead of hanging the suite. The
/// runtime stays alive between ticks, so a cycle an earlier tick started still runs.
struct TickThread {
    requests: tokio::sync::mpsc::UnboundedSender<tokio::sync::oneshot::Sender<()>>,
}

fn tick_thread(worker: Arc<DesignWorker>) -> TickThread {
    let (requests, mut queue) =
        tokio::sync::mpsc::unbounded_channel::<tokio::sync::oneshot::Sender<()>>();
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("a tick runtime");
        runtime.block_on(async move {
            while let Some(done) = queue.recv().await {
                worker.tick_now().await;
                let _ = done.send(());
            }
        });
    });
    TickThread { requests }
}

async fn a_tick_within_five_seconds(ticks: &TickThread, description: &str) {
    let (done, finished) = tokio::sync::oneshot::channel();
    ticks.requests.send(done).expect("the tick thread");
    let completed = tokio::time::timeout(Duration::from_secs(5), finished).await;
    assert!(
        completed.is_ok(),
        "{description} did not complete within 5 seconds"
    );
}

fn published_design_state(
    repo: &Path,
    anchor: &str,
    newest_cycle_id: &str,
    limits: (i64, i64),
    release: &str,
    updated_at: &str,
) -> devboard::workers::design::DesignState {
    let mut state = devboard::workers::design::empty_state("acme/fixture", repo, 0);
    state.lifecycle = devboard::workers::design::DesignLifecycle::Idle;
    state.enabled = true;
    state.limits = DesignLimits {
        max_per_hour: Some(limits.0),
        max_pending: Some(limits.1),
    };
    state.interval_minutes = 1;
    state.last_cycle_started_at = Some(anchor.to_string());
    state.sync = devboard::workers::design::DesignSync {
        state: DesignSyncState::Ok,
        at: Some(anchor.to_string()),
        error: None,
    };
    state.newest_cycle_id = Some(newest_cycle_id.to_string());
    state.release = Some(devboard::workers::design::DesignStateRelease {
        version: release.to_string(),
        url: format!("https://forge.test/acme/fixture/releases/tag/{release}"),
        at: anchor.to_string(),
    });
    state.updated_at = updated_at.to_string();
    state
}

fn write_published_design_state(
    state_dir: &Path,
    repo: &Path,
    version: Option<&str>,
    state: &devboard::workers::design::DesignState,
) {
    let path = match version {
        Some(version) => versioned_state_path(state_dir, repo, Some(version)),
        None => devboard::workers::design::state_path(state_dir, repo),
    };
    std::fs::create_dir_all(path.parent().expect("a state directory")).expect("state directory");
    devboard::workers::design::write_state(&path, state).expect("a published state");
}

/// A worker whose cadence comes from the published interval, not an override, and
/// whose ticker never fires on its own.
fn cadence_options(fixture: &Fixture, clock: &Arc<Clock>) -> DesignWorkerOptions {
    let mut options = DesignWorkerOptions::new(&fixture.repo, &fixture.state);
    options.harness_version = Some("test".to_string());
    options.sync_ms = Some(10_000);
    options.tick_ms = Some(3_600_000);
    options.now = Some(clock.function());
    options.argv = vec![
        "devboard".to_string(),
        "worker".to_string(),
        "design".to_string(),
    ];
    options
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_elapsed_cadence_after_a_published_cycle_starts_the_next_one() {
    let fixture = Fixture::new("cadence-published");
    let anchor = devboard::workers::design::iso_from_millis(NOW - 120_000);
    write_published_design_state(
        &fixture.state,
        &fixture.repo,
        Some("test"),
        &published_design_state(
            &fixture.repo,
            &anchor,
            "cycle-previous",
            (10, 5),
            "v1",
            &anchor,
        ),
    );
    let clock = Clock::new(NOW);
    let mut worker_options = cadence_options(&fixture, &clock);
    worker_options.forge = Some(FakeForge::new(Vec::new()) as Arc<dyn DesignForge>);
    worker_options.audit = Some(Arc::new(|_turn: AuditTurn| Box::pin(async move { Ok(()) })));
    let worker = Arc::new(DesignWorker::new(worker_options));
    assert!(worker.start("acme/fixture"));
    let ticks = tick_thread(Arc::clone(&worker));
    assert_eq!(
        worker.current_state().last_cycle_started_at.as_deref(),
        Some(anchor.as_str()),
        "the published cycle start is the inherited cadence anchor"
    );

    a_tick_within_five_seconds(&ticks, "the cadence tick").await;

    let state = worker.current_state();
    assert_eq!(
        state.last_cycle_started_at.as_deref(),
        Some(devboard::workers::design::iso_from_millis(NOW).as_str()),
        "the elapsed cadence publishes a new cycle start"
    );
    assert_eq!(
        cycle_directories(&fixture.repo).len(),
        1,
        "one cycle started"
    );
    worker.stop().await;
}

fn published_design(fixture: &Fixture) -> devboard::workers::design::DesignState {
    devboard::workers::design::read_state(&versioned_state_path(
        &fixture.state,
        &fixture.repo,
        Some("test"),
    ))
    .expect("the published state")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_completed_cycle_keeps_the_cadence_and_a_later_tick_consumes_a_control() {
    let fixture = Fixture::new("cadence-after-cycle");
    let mut published = devboard::workers::design::empty_state("acme/fixture", &fixture.repo, 0);
    published.lifecycle = devboard::workers::design::DesignLifecycle::Idle;
    published.enabled = true;
    published.interval_minutes = 1;
    published.updated_at = devboard::workers::design::iso_from_millis(NOW - 120_000);
    write_published_design_state(&fixture.state, &fixture.repo, Some("test"), &published);

    let clock = Clock::new(NOW);
    let mut worker_options = cadence_options(&fixture, &clock);
    worker_options.forge = Some(FakeForge::new(Vec::new()) as Arc<dyn DesignForge>);
    worker_options.audit = Some(Arc::new(|_turn: AuditTurn| Box::pin(async move { Ok(()) })));
    let worker = Arc::new(DesignWorker::new(worker_options));
    assert!(worker.start("acme/fixture"));
    let ticks = tick_thread(Arc::clone(&worker));

    a_tick_within_five_seconds(&ticks, "the first cycle").await;
    let finished = tokio::time::timeout(Duration::from_secs(5), worker.wait_for_cycle()).await;
    assert!(
        finished.is_ok(),
        "the first cycle did not finish within 5 seconds"
    );
    assert_eq!(
        cycle_directories(&fixture.repo).len(),
        1,
        "the first cycle starts"
    );
    let first_start = published_design(&fixture)
        .last_cycle_started_at
        .expect("the completed cycle records its start");

    clock.now.store(NOW + 30_000, Ordering::SeqCst);
    a_tick_within_five_seconds(&ticks, "the tick inside the cadence").await;
    assert_eq!(
        cycle_directories(&fixture.repo).len(),
        1,
        "the cadence gate still holds"
    );

    clock.now.store(NOW + 120_000, Ordering::SeqCst);
    a_tick_within_five_seconds(&ticks, "the tick after the cadence").await;
    assert_eq!(
        cycle_directories(&fixture.repo).len(),
        2,
        "the elapsed cadence starts the next cycle"
    );
    assert_ne!(
        published_design(&fixture).last_cycle_started_at.as_deref(),
        Some(first_start.as_str()),
        "the next cycle publishes its own start"
    );

    let control = versioned_control_directory(&fixture.state, &fixture.repo, Some("test"));
    write_command(
        &control,
        &DesignCommand::Settings {
            interval_minutes: 7,
            max_per_hour: Some(2),
            max_pending: Some(3),
        },
    )
    .expect("a settings command");
    a_tick_within_five_seconds(&ticks, "the tick after the control").await;
    assert_eq!(
        published_design(&fixture).interval_minutes,
        7,
        "the worker still consumes a control command after a cycle"
    );
    let _ = tokio::time::timeout(Duration::from_secs(5), worker.stop()).await;
}

fn inherited_design_worker(fixture: &Fixture) -> Arc<DesignWorker> {
    let clock = Clock::new(NOW);
    let mut options = options(fixture, &clock);
    options.forge = Some(FakeForge::new(Vec::new()) as Arc<dyn DesignForge>);
    options.audit = Some(Arc::new(|_turn: AuditTurn| Box::pin(async move { Ok(()) })));
    Arc::new(DesignWorker::new(options))
}

#[tokio::test]
async fn a_new_version_inherits_the_newest_published_state() {
    let fixture = Fixture::new("inherit-newest");
    write_published_design_state(
        &fixture.state,
        &fixture.repo,
        None,
        &published_design_state(
            &fixture.repo,
            "2026-01-01T00:00:00.000Z",
            "legacy-cycle",
            (11, 2),
            "v0.0.0",
            "2026-01-01T00:00:00.000Z",
        ),
    );
    write_published_design_state(
        &fixture.state,
        &fixture.repo,
        Some("0.0.1"),
        &published_design_state(
            &fixture.repo,
            "2026-01-02T00:00:00.000Z",
            "v1-cycle",
            (22, 3),
            "v0.0.1",
            "2026-01-02T00:00:00.000Z",
        ),
    );
    write_published_design_state(
        &fixture.state,
        &fixture.repo,
        Some("0.0.2"),
        &published_design_state(
            &fixture.repo,
            "2026-01-03T00:00:00.000Z",
            "v2-cycle",
            (33, 4),
            "v0.0.2",
            "2026-01-03T00:00:00.000Z",
        ),
    );
    let worker = inherited_design_worker(&fixture);
    assert!(worker.start("acme/fixture"));
    let state = worker.current_state();
    assert_eq!(
        state.last_cycle_started_at.as_deref(),
        Some("2026-01-03T00:00:00.000Z"),
        "the newest cadence anchor is inherited"
    );
    assert_eq!(state.newest_cycle_id.as_deref(), Some("v2-cycle"));
    assert_eq!(state.limits.max_per_hour, Some(33));
    assert_eq!(state.limits.max_pending, Some(4));
    assert_eq!(
        state
            .release
            .as_ref()
            .map(|release| release.version.as_str()),
        Some("v0.0.2"),
        "the newest release record is inherited"
    );
    assert_eq!(state.sync.at.as_deref(), Some("2026-01-03T00:00:00.000Z"));
    worker.stop().await;
}

#[tokio::test]
async fn a_newer_versioned_state_outranks_the_legacy_file() {
    let fixture = Fixture::new("inherit-precedence");
    write_published_design_state(
        &fixture.state,
        &fixture.repo,
        None,
        &published_design_state(
            &fixture.repo,
            "2026-01-01T00:00:00.000Z",
            "legacy-cycle",
            (11, 2),
            "v0.0.0",
            "2026-01-01T00:00:00.000Z",
        ),
    );
    write_published_design_state(
        &fixture.state,
        &fixture.repo,
        Some("0.0.1"),
        &published_design_state(
            &fixture.repo,
            "2026-01-05T00:00:00.000Z",
            "v1-cycle",
            (22, 3),
            "v0.0.1",
            "2026-01-05T00:00:00.000Z",
        ),
    );
    let newer_worker = inherited_design_worker(&fixture);
    assert!(newer_worker.start("acme/fixture"));
    let state = newer_worker.current_state();
    assert_eq!(
        state.last_cycle_started_at.as_deref(),
        Some("2026-01-05T00:00:00.000Z"),
        "the newer versioned anchor wins"
    );
    assert_eq!(state.newest_cycle_id.as_deref(), Some("v1-cycle"));
    assert_eq!(state.limits.max_per_hour, Some(22));
    assert_eq!(
        state
            .release
            .as_ref()
            .map(|release| release.version.as_str()),
        Some("v0.0.1")
    );
    newer_worker.stop().await;

    let legacy_only = Fixture::new("inherit-legacy-only");
    write_published_design_state(
        &legacy_only.state,
        &legacy_only.repo,
        None,
        &published_design_state(
            &legacy_only.repo,
            "2026-01-01T00:00:00.000Z",
            "legacy-cycle",
            (11, 2),
            "v0.0.0",
            "2026-01-01T00:00:00.000Z",
        ),
    );
    let legacy_worker = inherited_design_worker(&legacy_only);
    assert!(legacy_worker.start("acme/fixture"));
    let state = legacy_worker.current_state();
    assert_eq!(
        state.last_cycle_started_at.as_deref(),
        Some("2026-01-01T00:00:00.000Z"),
        "the legacy file is used when it is the only state"
    );
    assert_eq!(state.newest_cycle_id.as_deref(), Some("legacy-cycle"));
    assert_eq!(state.limits.max_per_hour, Some(11));
    legacy_worker.stop().await;
}

#[tokio::test]
async fn a_version_keeps_its_own_published_state() {
    let fixture = Fixture::new("inherit-own");
    write_published_design_state(
        &fixture.state,
        &fixture.repo,
        None,
        &published_design_state(
            &fixture.repo,
            "2026-01-04T00:00:00.000Z",
            "legacy-cycle",
            (11, 2),
            "v0.0.0",
            "2026-01-04T00:00:00.000Z",
        ),
    );
    write_published_design_state(
        &fixture.state,
        &fixture.repo,
        Some("0.0.1"),
        &published_design_state(
            &fixture.repo,
            "2026-01-05T00:00:00.000Z",
            "v1-cycle",
            (22, 3),
            "v0.0.1",
            "2026-01-05T00:00:00.000Z",
        ),
    );
    write_published_design_state(
        &fixture.state,
        &fixture.repo,
        Some("test"),
        &published_design_state(
            &fixture.repo,
            "2026-01-02T00:00:00.000Z",
            "own-cycle",
            (44, 5),
            "v0.0.4",
            "2026-01-02T00:00:00.000Z",
        ),
    );
    let worker = inherited_design_worker(&fixture);
    assert!(worker.start("acme/fixture"));
    let state = worker.current_state();
    assert_eq!(
        state.last_cycle_started_at.as_deref(),
        Some("2026-01-02T00:00:00.000Z"),
        "the version's own anchor is kept whatever other timestamps say"
    );
    assert_eq!(state.newest_cycle_id.as_deref(), Some("own-cycle"));
    assert_eq!(state.limits.max_per_hour, Some(44));
    worker.stop().await;
}
