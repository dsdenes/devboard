//! The Auto Scout worker: one fixture cycle with an injected forge and agent,
//! the exact state, request, scan, activity, claim, and lock files, capacity,
//! settings, drain, and stop semantics.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use devboard::acp::AcpActivity;
use devboard::forge::{ClientFuture, ClosingCommitClient, GitHubRelease};
use devboard::workers::scout::{
    activity_path, control_directory, lock_path, read_scan_claim, read_scan_file, read_settings,
    read_state, request_path, scan_directory, scans_directory, settings_path, state_path,
    version_lock_path, versioned_control_directory, versioned_state_path, write_command,
    write_scan_file, ForgeFuture, ScoutCommand, ScoutForge, ScoutForgeIssue, ScoutScanFile,
    ScoutScanRecord, ScoutWorker, ScoutWorkerOptions, ScoutWorkerRecord,
};
use serde_json::{json, Value};

/* ------------------------------------------------------------------------ */
/* Fixtures                                                                  */
/* ------------------------------------------------------------------------ */

fn scratch(label: &str) -> PathBuf {
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("scout-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let repo = base.join("repo");
    std::fs::create_dir_all(&repo).expect("a scratch repository");
    let output = Command::new("git")
        .args(["init", "-q"])
        .current_dir(&repo)
        .output()
        .expect("git init");
    assert!(output.status.success(), "git init failed");
    std::fs::create_dir_all(repo.join("src")).expect("a source directory");
    std::fs::write(
        repo.join("src/main.rs"),
        "fn main() {\n    println!(\"hello\");\n}\n",
    )
    .expect("a source file");
    for args in [
        vec!["add", "."],
        vec![
            "-c",
            "user.name=Scout Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "-q",
            "-m",
            "chore: fixture",
        ],
    ] {
        let output = Command::new("git")
            .args(&args)
            .current_dir(&repo)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .expect("git runs");
        assert!(
            output.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Command::new("git")
        .args([
            "remote",
            "add",
            "origin",
            "https://github.com/acme/fixture.git",
        ])
        .current_dir(&repo)
        .output()
        .expect("git remote");
    std::fs::canonicalize(&repo).expect("a canonical repository")
}

#[derive(Default)]
struct ForgeData {
    issues: Vec<ScoutForgeIssue>,
    open_titles: Vec<String>,
    releases: Vec<GitHubRelease>,
}

#[derive(Clone, Default)]
struct FixtureForge {
    data: Arc<Mutex<ForgeData>>,
}

impl FixtureForge {
    fn with_issues(issues: Vec<ScoutForgeIssue>) -> Self {
        let open_titles = issues
            .iter()
            .filter(|issue| issue.state == "open")
            .map(|issue| issue.title.clone())
            .collect();
        Self {
            data: Arc::new(Mutex::new(ForgeData {
                issues,
                open_titles,
                releases: Vec::new(),
            })),
        }
    }

    fn append(&self, issue: ScoutForgeIssue) {
        let mut data = self.data.lock().expect("the fixture forge");
        if issue.state == "open" {
            data.open_titles.push(issue.title.clone());
        }
        data.issues.push(issue);
    }
}

impl ClosingCommitClient for FixtureForge {
    fn closing_commit(&self, _issue_number: i64) -> ClientFuture<'_, Option<String>> {
        Box::pin(async { Ok(None) })
    }
    fn resolve_commit(&self, _short: String) -> ClientFuture<'_, Option<String>> {
        Box::pin(async { Ok(None) })
    }
    fn containing_release_tags(
        &self,
        _commit: String,
        _releases: Vec<GitHubRelease>,
    ) -> ClientFuture<'_, Vec<String>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

impl ScoutForge for FixtureForge {
    fn list_issues(&self) -> ForgeFuture<Vec<ScoutForgeIssue>> {
        let issues = self.data.lock().expect("the fixture forge").issues.clone();
        Box::pin(async move { Ok(issues) })
    }

    fn list_open_issue_titles(&self) -> ForgeFuture<Vec<String>> {
        let titles = self
            .data
            .lock()
            .expect("the fixture forge")
            .open_titles
            .clone();
        Box::pin(async move { Ok(titles) })
    }

    fn list_releases(&self) -> ForgeFuture<Vec<GitHubRelease>> {
        let releases = self
            .data
            .lock()
            .expect("the fixture forge")
            .releases
            .clone();
        Box::pin(async move { Ok(releases) })
    }

    fn closing_client(&self) -> &dyn ClosingCommitClient {
        self
    }
}

fn pending_issue(number: i64, title: &str, created_at: &str) -> ScoutForgeIssue {
    ScoutForgeIssue {
        number,
        title: title.to_string(),
        url: format!("https://github.com/acme/fixture/issues/{number}"),
        state: "open".to_string(),
        created_at: created_at.to_string(),
        closed_at: None,
        body: "## Category\nclarity\n\nThe finding.".to_string(),
    }
}

fn worker(
    repo: &Path,
    forge: FixtureForge,
    agent: devboard::workers::scout::ScanAgent,
) -> ScoutWorker {
    let mut options = ScoutWorkerOptions::new(repo, repo.join(".devboard").join("state"));
    options.harness_version = Some("test-version".to_string());
    options.forge = Some(Arc::new(forge));
    options.agent = Some(agent);
    options.sync_ms = Some(1000);
    options.cadence_ms = Some(1000);
    options.tick_ms = Some(10);
    options.timeout_ms = Some(10_000);
    ScoutWorker::new(options)
}

/// An agent that records activity, files one issue through the tool log, and
/// makes the forge report it.
fn filing_agent(forge: FixtureForge) -> devboard::workers::scout::ScanAgent {
    Arc::new(move |context: devboard::workers::scout::ScanAgentContext| {
        let forge = forge.clone();
        Box::pin(async move {
            (context.activity)(AcpActivity {
                text: "surveyed the entry point".to_string(),
                append: false,
            });
            let record = json!({
                "tool": "issue_create",
                "at": "2026-11-03T12:00:00.000Z",
                "ok": true,
                "value": {"number": 12, "title": "Clarify the entry point"}
            });
            let _ = std::fs::write(
                context.directory.join("tool-log.jsonl"),
                format!("{record}\n"),
            );
            forge.append(pending_issue(
                12,
                "Clarify the entry point",
                "2026-11-03T12:00:00.000Z",
            ));
            Ok(())
        })
    })
}

fn scan_ids(repo: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(scans_directory(repo)) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/* ------------------------------------------------------------------------ */
/* Tests                                                                     */
/* ------------------------------------------------------------------------ */

#[tokio::test]
async fn one_cycle_files_the_recommendation_and_writes_every_record() {
    let repo = scratch("cycle");
    let forge = FixtureForge::default();
    let worker = worker(&repo, forge.clone(), filing_agent(forge));
    assert!(worker.start("acme/fixture"));

    let state_file = versioned_state_path(
        &repo.join(".devboard").join("state"),
        &repo,
        Some("test-version"),
    );
    assert!(
        state_file.exists(),
        "the versioned state is published at start"
    );
    let started = read_state(&state_file).expect("the published state");
    assert_eq!(started.lifecycle, "idle");
    assert!(started.enabled);
    assert_eq!(
        started.worker.as_ref().map(|worker| worker.pid),
        Some(std::process::id())
    );
    assert_eq!(
        started
            .worker
            .as_ref()
            .and_then(|worker| worker.harness_version.as_deref()),
        Some("test-version")
    );

    worker.tick_now().await;
    let state = worker.current_state();
    assert_eq!(
        state.lifecycle, "idle",
        "a succeeded scan returns the worker to idle"
    );
    assert!(state.enabled);
    assert_eq!(
        state.issues.len(),
        1,
        "the settled read adopted the filed issue"
    );
    let row = &state.issues[0];
    assert_eq!(row.number, 12);
    assert_eq!(row.state.as_str(), "pending");
    assert_eq!(row.category.as_deref(), Some("clarity"));
    assert_eq!(
        state.open_titles,
        vec!["Clarify the entry point".to_string()]
    );
    assert_eq!(state.sync.state, "ok");
    assert_eq!(state.scan, None);
    assert!(state.notice.as_deref().unwrap().contains("Filed #12"));

    let ids = scan_ids(&repo);
    assert_eq!(ids.len(), 1);
    let directory = scan_directory(&repo, &ids[0]);
    let request: Value = serde_json::from_str(
        &std::fs::read_to_string(request_path(&directory)).expect("the request"),
    )
    .expect("request JSON");
    assert_eq!(request["version"], 4);
    assert_eq!(request["scanId"], ids[0]);
    assert_eq!(request["repository"], "acme/fixture");
    assert_eq!(request["requested"], 5);
    assert_eq!(request["surface"], "scout");
    assert_eq!(request["significanceThreshold"], 4);
    assert_eq!(request["maxPerHour"], 10);
    assert_eq!(request["maxPending"], 5);
    assert_eq!(
        request["categories"].as_array().expect("categories").len(),
        6
    );
    let entry_path = request["entryPoint"]["path"]
        .as_str()
        .expect("an entry path");
    assert!(repo.join(entry_path).is_file());
    assert!(
        request["entryPoint"]["line"].as_i64().expect("a line") >= 1,
        "the entry point names a 1-based line"
    );

    let scan = read_scan_file(&directory).expect("the scan record");
    assert_eq!(scan.status, "succeeded");
    assert_eq!(scan.filed, 1);
    assert_eq!(scan.requested, 5);
    assert_eq!(scan.repo, "acme/fixture");
    assert_eq!(scan.worker_pid, std::process::id());
    assert_eq!(scan.harness_version.as_deref(), Some("test-version"));
    assert!(scan.finished_at.is_some());
    assert_eq!(
        scan.prompt,
        format!("/scout-recommendations {}", directory.display())
    );

    let activity: Vec<String> = serde_json::from_str(
        &std::fs::read_to_string(activity_path(&directory)).expect("the activity"),
    )
    .expect("activity JSON");
    assert!(activity.iter().any(|line| line.contains("entry point")));
    assert!(activity
        .iter()
        .any(|line| line == "surveyed the entry point"));
    assert!(activity.iter().any(|line| line.contains("filed #12")));

    let claim = read_scan_claim(&repo);
    assert!(
        claim.is_none(),
        "the scan slot is released when the scan ends"
    );
    let lock = version_lock_path(&lock_path(&repo), Some("test-version"));
    assert!(lock.exists(), "the worker holds the repository lock");

    worker.stop().await;
    let stopped = read_state(&state_file).expect("the final state");
    assert_eq!(stopped.lifecycle, "stopped");
    assert!(!stopped.enabled);
    assert!(!lock.exists(), "Stop releases the lock");
}

#[tokio::test]
async fn the_open_issue_cap_blocks_a_scan_and_names_when_it_clears() {
    let repo = scratch("cap");
    let now = devboard::workers::scout::now_millis();
    let created = devboard::workers::scout::iso_from_millis(now - 60_000);
    let issues: Vec<ScoutForgeIssue> = (1..=5)
        .map(|number| pending_issue(number, &format!("Finding {number}"), &created))
        .collect();
    let forge = FixtureForge::with_issues(issues);
    let worker = worker(
        &repo,
        forge.clone(),
        Arc::new(|_context| Box::pin(async { Ok(()) })),
    );
    assert!(worker.start("acme/fixture"));
    worker.tick_now().await;

    let state = worker.current_state();
    assert_eq!(state.sync.state, "ok");
    assert_eq!(state.issues.len(), 5);
    assert_eq!(state.lifecycle, "idle");
    assert!(state.scan.is_none(), "the cap admits no scan");
    let blocked = state
        .next_attempt_at
        .as_deref()
        .and_then(devboard::workers::scout::parse_iso_millis)
        .expect("a blocked instant");
    assert!(blocked > now, "the block names a future instant");
    assert!(scan_ids(&repo).is_empty(), "no scan directory is created");

    worker.stop().await;
}

#[tokio::test]
async fn a_settings_command_persists_the_cadence_and_caps() {
    let repo = scratch("settings");
    let forge = FixtureForge::default();
    let worker = worker(
        &repo,
        forge,
        Arc::new(|_context| Box::pin(async { Ok(()) })),
    );
    assert!(worker.start("acme/fixture"));
    let directory = versioned_control_directory(
        &repo.join(".devboard").join("state"),
        &repo,
        Some("test-version"),
    );
    write_command(
        &directory,
        &ScoutCommand::Settings {
            interval_minutes: 30,
            max_per_hour: Some(4),
            max_pending: None,
        },
    )
    .expect("a settings command");
    worker.tick().await;

    let state = worker.current_state();
    assert_eq!(state.interval_minutes, 30);
    assert_eq!(state.limits.max_per_hour, Some(4));
    assert_eq!(state.limits.max_pending, None);
    assert!(state.notice.as_deref().unwrap().contains("Settings saved"));
    let settings = read_settings(&settings_path(&repo.join(".devboard").join("state"), &repo))
        .expect("the persisted settings");
    assert_eq!(settings.interval_minutes, 30);
    assert_eq!(settings.max_per_hour, Some(4));
    assert_eq!(settings.max_pending, None);
    worker.stop().await;
}

#[tokio::test]
async fn an_invalid_settings_command_is_refused_without_persisting() {
    let repo = scratch("invalid-settings");
    let forge = FixtureForge::default();
    let worker = worker(
        &repo,
        forge,
        Arc::new(|_context| Box::pin(async { Ok(()) })),
    );
    assert!(worker.start("acme/fixture"));
    // A hand-written command bypasses the writer's own validation.
    let directory = versioned_control_directory(
        &repo.join(".devboard").join("state"),
        &repo,
        Some("test-version"),
    );
    std::fs::create_dir_all(&directory).expect("the control directory");
    std::fs::write(
        directory.join("00000000000001-000001.json"),
        "{\"type\":\"settings\",\"intervalMinutes\":0,\"maxPerHour\":10,\"maxPending\":5}\n",
    )
    .expect("an invalid command");
    worker.tick().await;
    let state = worker.current_state();
    assert_eq!(
        state.interval_minutes, 1,
        "an unparsable command changes nothing"
    );
    assert!(state.last_error.is_none());
    assert!(read_settings(&settings_path(&repo.join(".devboard").join("state"), &repo)).is_none());
    worker.stop().await;
}

#[tokio::test]
async fn drain_finishes_the_idle_worker_and_records_the_reason() {
    let repo = scratch("drain");
    let forge = FixtureForge::default();
    let worker = worker(
        &repo,
        forge,
        Arc::new(|_context| Box::pin(async { Ok(()) })),
    );
    assert!(worker.start("acme/fixture"));
    write_command(
        &versioned_control_directory(
            &repo.join(".devboard").join("state"),
            &repo,
            Some("test-version"),
        ),
        &ScoutCommand::Drain,
    )
    .expect("a drain command");
    worker.tick().await;
    let state = worker.current_state();
    assert_eq!(state.lifecycle, "stopped");
    assert!(!state.enabled);
    assert_eq!(
        state.notice.as_deref(),
        Some("Drained: the worker finished its work and exited; its records stay readable.")
    );
    assert!(!version_lock_path(&lock_path(&repo), Some("test-version")).exists());
}

#[tokio::test]
async fn stop_during_a_scan_records_it_stopped_and_releases_the_slot() {
    let repo = scratch("stop-scan");
    let forge = FixtureForge::default();
    let runs = Arc::new(AtomicUsize::new(0));
    let counter = runs.clone();
    let agent: devboard::workers::scout::ScanAgent = Arc::new(move |_context| {
        counter.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            Ok(())
        })
    });
    let worker = worker(&repo, forge, agent);
    assert!(worker.start("acme/fixture"));
    worker.tick().await;
    assert!(worker.scanning(), "the scan is in flight");
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(runs.load(Ordering::SeqCst), 1, "one scan started");

    for _ in 0..200 {
        if !scan_ids(&repo).is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let ids = scan_ids(&repo);
    assert_eq!(ids.len(), 1);
    let directory = scan_directory(&repo, &ids[0]);
    worker.stop().await;
    let state = worker.current_state();
    assert_eq!(state.lifecycle, "stopped");
    assert!(!state.enabled);
    let scan = read_scan_file(&directory).expect("the stopped record");
    assert_eq!(scan.status, "stopped");
    assert_eq!(scan.filed, 0);
    assert!(!version_lock_path(&lock_path(&repo), Some("test-version")).exists());
    assert!(read_scan_claim(&repo).is_none());
}

#[tokio::test]
async fn a_second_worker_of_the_same_version_refuses_the_same_checkout() {
    let repo = scratch("singleton");
    let forge = FixtureForge::default();
    let first = worker(
        &repo,
        forge.clone(),
        Arc::new(|_context| Box::pin(async { Ok(()) })),
    );
    let second = worker(
        &repo,
        forge,
        Arc::new(|_context| Box::pin(async { Ok(()) })),
    );
    assert!(first.start("acme/fixture"));
    assert!(!second.start("acme/fixture"));
    first.stop().await;
    assert!(second.start("acme/fixture"));
    second.stop().await;
}

#[tokio::test]
async fn a_version_one_state_is_migrated_and_discards_staged_recommendations() {
    let repo = scratch("migrate");
    let state_dir = repo.join(".devboard").join("state");
    let path = state_path(&state_dir, &repo);
    std::fs::create_dir_all(path.parent().expect("a state directory")).expect("state dir");
    std::fs::write(
        &path,
        serde_json::to_string(&json!({
            "version": 1,
            "repo": "acme/fixture",
            "root": repo.to_string_lossy(),
            "lifecycle": "idle",
            "enabled": true,
            "worker": null,
            "staged": [{"title": "one"}, {"title": "two"}],
            "scan": null,
            "newestScanId": null,
            "lastError": null,
            "notice": null,
            "updatedAt": "2026-11-03T12:00:00.000Z"
        }))
        .expect("state JSON"),
    )
    .expect("a version-1 state");
    let forge = FixtureForge::default();
    let worker = worker(
        &repo,
        forge,
        Arc::new(|_context| Box::pin(async { Ok(()) })),
    );
    assert!(worker.start("acme/fixture"));
    let state = worker.current_state();
    assert_eq!(
        state.notice.as_deref(),
        Some(
            "Discarded 2 staged recommendations from the previous Auto Scout version; \
             nothing was filed."
        )
    );
    assert!(state.issues.is_empty());
    assert_eq!(state.limits.max_per_hour, Some(10));
    worker.stop().await;
}

#[tokio::test]
async fn control_commands_are_consumed_in_name_order_from_both_channels() {
    let repo = scratch("control");
    let state_dir = repo.join(".devboard").join("state");
    let forge = FixtureForge::default();
    let worker = worker(
        &repo,
        forge,
        Arc::new(|_context| Box::pin(async { Ok(()) })),
    );
    assert!(worker.start("acme/fixture"));
    let legacy = control_directory(&state_dir, &repo);
    let versioned = versioned_control_directory(&state_dir, &repo, Some("test-version"));
    write_command(
        &versioned,
        &ScoutCommand::Settings {
            interval_minutes: 7,
            max_per_hour: Some(2),
            max_pending: Some(3),
        },
    )
    .expect("a versioned settings command");
    write_command(&legacy, &ScoutCommand::Refresh).expect("a legacy refresh command");
    worker.consume_commands().await;
    let state = worker.current_state();
    assert_eq!(state.interval_minutes, 7);
    assert_eq!(state.limits.max_per_hour, Some(2));
    assert!(
        std::fs::read_dir(&versioned)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(true),
        "the versioned channel is drained"
    );
    worker.stop().await;
}

#[tokio::test]
async fn a_transient_read_failure_keeps_the_last_rows_and_retries_shortly() {
    struct FailingForge;
    impl ScoutForge for FailingForge {
        fn list_issues(&self) -> ForgeFuture<Vec<ScoutForgeIssue>> {
            Box::pin(async { Err("request timed out".to_string()) })
        }
        fn list_open_issue_titles(&self) -> ForgeFuture<Vec<String>> {
            Box::pin(async { Ok(Vec::new()) })
        }
        fn list_releases(&self) -> ForgeFuture<Vec<GitHubRelease>> {
            Box::pin(async { Ok(Vec::new()) })
        }
        fn closing_client(&self) -> &dyn ClosingCommitClient {
            &NullClosing
        }
    }
    struct NullClosing;
    impl ClosingCommitClient for NullClosing {
        fn closing_commit(&self, _n: i64) -> ClientFuture<'_, Option<String>> {
            Box::pin(async { Ok(None) })
        }
        fn resolve_commit(&self, _s: String) -> ClientFuture<'_, Option<String>> {
            Box::pin(async { Ok(None) })
        }
        fn containing_release_tags(
            &self,
            _c: String,
            _r: Vec<GitHubRelease>,
        ) -> ClientFuture<'_, Vec<String>> {
            Box::pin(async { Ok(Vec::new()) })
        }
    }
    let repo = scratch("transient");
    let mut options = ScoutWorkerOptions::new(&repo, repo.join(".devboard").join("state"));
    options.harness_version = Some("test-version".to_string());
    options.forge = Some(Arc::new(FailingForge));
    options.agent = Some(Arc::new(|_context| Box::pin(async { Ok(()) })));
    options.sync_ms = Some(1000);
    let worker = ScoutWorker::new(options);
    assert!(worker.start("acme/fixture"));
    worker.tick_now().await;
    let state = worker.current_state();
    assert_eq!(state.sync.state, "stale", "a transient failure stays stale");
    assert!(
        state.sync.error.is_none(),
        "the retry window is not an alert"
    );
    assert!(state.last_error.is_none());
    assert!(state.next_attempt_at.is_none());
    worker.stop().await;
}

/// A forge that cannot answer its issue read: the same message comes back on
/// every attempt, so a test drives the shared retry schedule to exhaustion.
struct UnavailableForge {
    detail: String,
}

impl ClosingCommitClient for UnavailableForge {
    fn closing_commit(&self, _n: i64) -> ClientFuture<'_, Option<String>> {
        Box::pin(async { Ok(None) })
    }
    fn resolve_commit(&self, _s: String) -> ClientFuture<'_, Option<String>> {
        Box::pin(async { Ok(None) })
    }
    fn containing_release_tags(
        &self,
        _c: String,
        _r: Vec<GitHubRelease>,
    ) -> ClientFuture<'_, Vec<String>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

impl ScoutForge for UnavailableForge {
    fn list_issues(&self) -> ForgeFuture<Vec<ScoutForgeIssue>> {
        let detail = self.detail.clone();
        Box::pin(async move { Err(detail) })
    }
    fn list_open_issue_titles(&self) -> ForgeFuture<Vec<String>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    fn list_releases(&self) -> ForgeFuture<Vec<GitHubRelease>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    fn closing_client(&self) -> &dyn ClosingCommitClient {
        self
    }
}

fn failing_worker(repo: &Path, detail: &str) -> ScoutWorker {
    let mut options = ScoutWorkerOptions::new(repo, repo.join(".devboard").join("state"));
    options.harness_version = Some("test-version".to_string());
    options.forge = Some(Arc::new(UnavailableForge {
        detail: detail.to_string(),
    }));
    options.agent = Some(Arc::new(|_context| Box::pin(async { Ok(()) })));
    options.sync_ms = Some(1000);
    ScoutWorker::new(options)
}

/// The fifth consecutive transport failure names its request on the card, but
/// a forge that never answered is not the agent's own error: raising
/// `agent-error` opens a dashboard error notification that files a board issue
/// back into the forge that is down.
#[tokio::test]
async fn an_unavailable_forge_keeps_its_reason_on_the_card() {
    let detail =
        "GET /repos/acme/fixture/issues?state=all&type=issues&limit=50&page=1&labels=scout \
                  failed: error sending request for url \
                  (http://localhost:3001/api/v1/repos/acme/fixture/issues): client error \
                  (Connect): tcp connect error: Connection refused (os error 111)";
    let repo = scratch("unavailable");
    let worker = failing_worker(&repo, detail);
    assert!(worker.start("acme/fixture"));
    for _ in 0..5 {
        worker.refresh().await;
    }
    let state = worker.current_state();
    assert_eq!(state.sync.state, "error", "the schedule is spent");
    assert_eq!(
        state.sync.error.as_deref(),
        Some(detail),
        "the card names the request that failed"
    );
    assert!(
        state.last_error.is_none(),
        "an outage raises no error notification: {:?}",
        state.last_error
    );
    assert_eq!(
        state.notice.as_deref(),
        Some(format!("Could not read the forge: {detail}").as_str())
    );
    worker.stop().await;
}

/// A refusal the forge answered is the credential's problem, not an outage, so
/// the exhausted schedule still raises `agent-error`.
#[tokio::test]
async fn a_refused_read_still_raises_the_error_alarm() {
    let detail = "GET /repos/acme/fixture/issues failed (HTTP 401): \
                  invalid username, password or token";
    let repo = scratch("refused");
    let worker = failing_worker(&repo, detail);
    assert!(worker.start("acme/fixture"));
    for _ in 0..5 {
        worker.refresh().await;
    }
    let state = worker.current_state();
    assert_eq!(state.sync.state, "error");
    assert_eq!(state.last_error.as_deref(), Some(detail));
    worker.stop().await;
}

/// A forge that answers in 39 seconds is slow, not broken: the read's deadline
/// expires, and the worker must keep the last rows and read again on its normal
/// cadence instead of spending the failure schedule and raising the
/// "the forge read did not finish within" error notification that files a board
/// issue.
#[tokio::test]
async fn a_slow_forge_read_never_raises_the_error_alarm() {
    struct SlowForge;
    impl ScoutForge for SlowForge {
        fn list_issues(&self) -> ForgeFuture<Vec<ScoutForgeIssue>> {
            Box::pin(async {
                tokio::time::sleep(Duration::from_secs(60)).await;
                Ok(Vec::new())
            })
        }
        fn list_open_issue_titles(&self) -> ForgeFuture<Vec<String>> {
            Box::pin(async {
                tokio::time::sleep(Duration::from_secs(60)).await;
                Ok(Vec::new())
            })
        }
        fn list_releases(&self) -> ForgeFuture<Vec<GitHubRelease>> {
            Box::pin(async {
                tokio::time::sleep(Duration::from_secs(60)).await;
                Ok(Vec::new())
            })
        }
        fn closing_client(&self) -> &dyn ClosingCommitClient {
            &NullClosing
        }
    }
    struct NullClosing;
    impl ClosingCommitClient for NullClosing {
        fn closing_commit(&self, _n: i64) -> ClientFuture<'_, Option<String>> {
            Box::pin(async { Ok(None) })
        }
        fn resolve_commit(&self, _s: String) -> ClientFuture<'_, Option<String>> {
            Box::pin(async { Ok(None) })
        }
        fn containing_release_tags(
            &self,
            _c: String,
            _r: Vec<GitHubRelease>,
        ) -> ClientFuture<'_, Vec<String>> {
            Box::pin(async { Ok(Vec::new()) })
        }
    }
    let repo = scratch("slow-read");
    let mut options = ScoutWorkerOptions::new(&repo, repo.join(".devboard").join("state"));
    options.harness_version = Some("test-version".to_string());
    options.forge = Some(Arc::new(SlowForge));
    options.agent = Some(Arc::new(|_context| Box::pin(async { Ok(()) })));
    options.read_timeout_ms = Some(20);
    options.sync_ms = Some(1000);
    let worker = ScoutWorker::new(options);
    assert!(worker.start("acme/fixture"));
    for _ in 0..6 {
        worker.refresh().await;
    }
    let state = worker.current_state();
    assert_eq!(state.sync.state, "stale");
    assert!(
        state.sync.error.is_none(),
        "latency is not a read failure: {:?}",
        state.sync.error
    );
    assert!(
        state.last_error.is_none(),
        "the sixth slow read still raises no error: {:?}",
        state.last_error
    );
    assert!(state.notice.is_none(), "no notice for a slow forge");
    assert!(state.next_attempt_at.is_none());
    worker.stop().await;
}

#[tokio::test]
async fn run_reaches_a_stopped_state_and_exits_after_a_stop_command() {
    let repo = scratch("run");
    let forge = FixtureForge::default();
    let worker = Arc::new(worker(
        &repo,
        forge,
        Arc::new(|_context| Box::pin(async { Ok(()) })),
    ));
    assert!(worker.start("acme/fixture"));
    let loop_worker = Arc::clone(&worker);
    let task =
        tokio::spawn(async move { devboard::workers::scout::run_worker(&loop_worker).await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    write_command(
        &versioned_control_directory(
            &repo.join(".devboard").join("state"),
            &repo,
            Some("test-version"),
        ),
        &ScoutCommand::Stop,
    )
    .expect("a stop command");
    let ran = tokio::time::timeout(Duration::from_secs(15), task)
        .await
        .expect("the worker loop stops")
        .expect("the worker task");
    assert!(ran);
    let state = worker.current_state();
    assert_eq!(state.lifecycle, "stopped");
    assert!(!state.enabled);
    assert!(!version_lock_path(&lock_path(&repo), Some("test-version")).exists());
}

#[test]
fn the_worker_command_refuses_a_checkout_without_an_origin() {
    let repo = scratch("exit-origin");
    let output = Command::new("git")
        .args(["remote", "remove", "origin"])
        .current_dir(&repo)
        .output()
        .expect("git remote remove");
    assert!(output.status.success());
    let output = Command::new(env!("CARGO_BIN_EXE_devboard"))
        .args([
            "worker",
            "scout",
            "--repo",
            repo.to_str().expect("a path"),
            "--state-dir",
            repo.join(".devboard")
                .join("state")
                .to_str()
                .expect("a path"),
        ])
        .output()
        .expect("the devboard binary runs");
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr)
        .contains("the checkout's origin does not name a repository"));
}

#[test]
fn the_worker_command_refuses_missing_arguments_with_code_two() {
    let repo = scratch("exit-usage");
    let output = Command::new(env!("CARGO_BIN_EXE_devboard"))
        .args(["worker", "scout", "--repo", repo.to_str().expect("a path")])
        .output()
        .expect("the devboard binary runs");
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("usage:"));
}

#[test]
fn the_worker_command_exits_zero_when_a_live_scout_already_owns_the_version() {
    let repo = scratch("exit-live");
    let version = "exit-version";
    let started = devboard::supervision::process_age_ms(std::process::id())
        .map(|age| {
            devboard::workers::scout::iso_from_millis(
                devboard::workers::scout::now_millis() - age as i64,
            )
        })
        .unwrap_or_else(|| {
            devboard::workers::scout::iso_from_millis(devboard::workers::scout::now_millis())
        });
    let path = version_lock_path(&lock_path(&repo), Some(version));
    std::fs::create_dir_all(path.parent().expect("a lock directory")).expect("a lock directory");
    std::fs::write(
        &path,
        serde_json::to_string(&json!({
            "repo": repo.to_string_lossy(),
            "stateDir": repo.join(".devboard").join("state").to_string_lossy(),
            "harnessVersion": version,
            "argv": ["devboard"],
            "pid": std::process::id(),
            "startedAt": started,
            "token": "fixture-token"
        }))
        .expect("a lock document")
            + "\n",
    )
    .expect("a live lock");
    let output = Command::new(env!("CARGO_BIN_EXE_devboard"))
        .args([
            "worker",
            "scout",
            "--repo",
            repo.to_str().expect("a path"),
            "--state-dir",
            repo.join(".devboard")
                .join("state")
                .to_str()
                .expect("a path"),
        ])
        .env("DEVBOARD_HARNESS_VERSION", version)
        .output()
        .expect("the devboard binary runs");
    assert_eq!(output.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&output.stderr)
        .contains("already has a live scout for this version"));
}

#[tokio::test]
async fn two_versions_share_one_checkout_and_one_scan_slot() {
    let repo = scratch("coexist");
    let forge = FixtureForge::default();
    let gate = Arc::new(tokio::sync::Notify::new());
    let agent_gate = Arc::clone(&gate);
    let agent: devboard::workers::scout::ScanAgent = Arc::new(move |_context| {
        let gate = Arc::clone(&agent_gate);
        Box::pin(async move {
            gate.notified().await;
            Ok(())
        })
    });
    let mut older_options = ScoutWorkerOptions::new(&repo, repo.join(".devboard").join("state"));
    older_options.harness_version = Some("0.0.9".to_string());
    older_options.forge = Some(Arc::new(forge.clone()));
    older_options.agent = Some(Arc::clone(&agent));
    older_options.sync_ms = Some(1000);
    older_options.cadence_ms = Some(1000);
    older_options.timeout_ms = Some(10_000);
    let older = ScoutWorker::new(older_options);

    let mut newer_options = ScoutWorkerOptions::new(&repo, repo.join(".devboard").join("state"));
    newer_options.harness_version = Some("1.0.0".to_string());
    newer_options.forge = Some(Arc::new(forge));
    newer_options.agent = Some(Arc::new(|_context| Box::pin(async { Ok(()) })));
    newer_options.sync_ms = Some(1000);
    newer_options.cadence_ms = Some(1000);
    newer_options.timeout_ms = Some(10_000);
    let newer = ScoutWorker::new(newer_options);

    assert!(older.start("acme/fixture"));
    assert!(
        newer.start("acme/fixture"),
        "a second version has its own lock"
    );
    let state_dir = repo.join(".devboard").join("state");
    assert!(versioned_state_path(&state_dir, &repo, Some("0.0.9")).exists());
    assert!(versioned_state_path(&state_dir, &repo, Some("1.0.0")).exists());

    older.tick().await;
    assert!(
        older.scanning(),
        "the older version owns the in-flight scan"
    );
    let claim = read_scan_claim(&repo).expect("the scan claim");
    assert_eq!(claim.pid, std::process::id());
    assert_eq!(claim.harness_version.as_deref(), Some("0.0.9"));
    assert!(claim.scan_id.is_some());

    newer.tick_now().await;
    assert!(!newer.scanning(), "the held slot admits no second scan");
    assert_eq!(scan_ids(&repo).len(), 1);
    assert!(newer.current_state().scan.is_none());
    assert_eq!(newer.current_state().lifecycle, "idle");

    gate.notify_one();
    older.settle().await;
    assert!(
        !older.scanning(),
        "the older scan finishes and releases the slot"
    );
    assert!(read_scan_claim(&repo).is_none());

    newer.tick_now().await;
    assert_eq!(
        scan_ids(&repo).len(),
        2,
        "the newer version scans after the release"
    );
    older.stop().await;
    newer.stop().await;
    assert!(!version_lock_path(&lock_path(&repo), Some("0.0.9")).exists());
    assert!(!version_lock_path(&lock_path(&repo), Some("1.0.0")).exists());
}

#[tokio::test]
async fn a_fresh_worker_closes_a_dead_workers_scan_without_an_error() {
    let repo = scratch("interrupted-scan");
    let state_dir = repo.join(".devboard").join("state");
    let started_at = "2026-11-05T14:01:50.922Z";
    let mut previous = published_state(
        &repo,
        started_at,
        "scan-interrupted",
        (10, 5),
        "v1",
        "2026-11-05T14:14:47.576Z",
    );
    previous.worker = Some(ScoutWorkerRecord {
        pid: u32::MAX,
        started_at: "2026-11-05T14:01:24.899Z".to_string(),
        state_dir: state_dir.to_string_lossy().into_owned(),
        harness_version: Some("0.0.1".to_string()),
        argv: Vec::new(),
    });
    previous.scan = Some(ScoutScanRecord {
        scan_id: "scan-interrupted".to_string(),
        started_at: started_at.to_string(),
        requested: 1,
    });
    write_published_state(&state_dir, &repo, Some("0.0.1"), &previous);
    let directory = scan_directory(&repo, "scan-interrupted");
    write_scan_file(
        &directory,
        &ScoutScanFile {
            version: 2,
            scan_id: "scan-interrupted".to_string(),
            repo: "acme/fixture".to_string(),
            root: repo.to_string_lossy().into_owned(),
            status: "running".to_string(),
            started_at: started_at.to_string(),
            finished_at: None,
            requested: 1,
            filed: 0,
            prompt: "/scout-recommendations".to_string(),
            acp: None,
            error: None,
            shortfall: None,
            worker_pid: u32::MAX,
            harness_version: Some("0.0.1".to_string()),
        },
    )
    .expect("the running scan record");

    let worker = worker(
        &repo,
        FixtureForge::default(),
        Arc::new(|_context| Box::pin(async { Ok(()) })),
    );
    assert!(worker.start("acme/fixture"));
    let state = worker.current_state();
    assert_eq!(
        state.last_error, None,
        "a recovered interruption is not the running worker's error"
    );
    assert_eq!(state.newest_scan_id.as_deref(), Some("scan-interrupted"));
    let scan = read_scan_file(&directory).expect("the closed record");
    assert_eq!(scan.status, "failed");
    assert_eq!(
        scan.error.as_deref(),
        Some("the worker that owned this scan exited")
    );
    worker.stop().await;
}

/* ------------------------------------------------------------------------ */
/* Cadence liveness and the inherited startup state                          */
/* ------------------------------------------------------------------------ */

/// The worker's ticks, on one thread and one runtime of their own, so a gate that
/// never returns fails the test within its bound instead of hanging the suite.
struct TickThread {
    requests: tokio::sync::mpsc::UnboundedSender<tokio::sync::oneshot::Sender<()>>,
}

fn tick_thread(worker: Arc<ScoutWorker>) -> TickThread {
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

fn published_state(
    repo: &Path,
    anchor: &str,
    newest_scan_id: &str,
    limits: (i64, i64),
    release_signature: &str,
    updated_at: &str,
) -> devboard::workers::scout::ScoutState {
    let mut state = devboard::workers::scout::empty_state("acme/fixture", repo, 0);
    state.lifecycle = "idle".to_string();
    state.enabled = true;
    state.limits = devboard::workers::scout::ScoutLimits {
        max_per_hour: Some(limits.0),
        max_pending: Some(limits.1),
    };
    state.interval_minutes = 1;
    state.last_scan_started_at = Some(anchor.to_string());
    state.release_signature = Some(release_signature.to_string());
    state.sync = devboard::workers::scout::ScoutSync {
        state: "ok".to_string(),
        at: Some(anchor.to_string()),
        error: None,
    };
    state.newest_scan_id = Some(newest_scan_id.to_string());
    state.updated_at = updated_at.to_string();
    state
}

fn write_published_state(
    state_dir: &Path,
    repo: &Path,
    version: Option<&str>,
    state: &devboard::workers::scout::ScoutState,
) {
    let path = match version {
        Some(version) => versioned_state_path(state_dir, repo, Some(version)),
        None => state_path(state_dir, repo),
    };
    std::fs::create_dir_all(path.parent().expect("a state directory")).expect("state directory");
    devboard::workers::scout::write_state(&path, state).expect("a published state");
}

/// A worker whose cadence comes from the published interval, not an override.
fn cadence_worker(repo: &Path, forge: FixtureForge, clock: Arc<AtomicI64>) -> ScoutWorker {
    let mut options = ScoutWorkerOptions::new(repo, repo.join(".devboard").join("state"));
    options.harness_version = Some("test-version".to_string());
    options.forge = Some(Arc::new(forge));
    options.agent = Some(Arc::new(|_context| Box::pin(async { Ok(()) })));
    options.sync_ms = Some(1000);
    options.tick_ms = Some(10);
    options.timeout_ms = Some(10_000);
    options.now = Some(Arc::new(move || clock.load(Ordering::SeqCst)));
    ScoutWorker::new(options)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_elapsed_cadence_after_a_published_run_starts_the_next_scan() {
    let repo = scratch("cadence-published");
    let state_dir = repo.join(".devboard").join("state");
    let now = 1_780_000_000_000i64;
    let anchor = devboard::workers::scout::iso_from_millis(now - 120_000);
    write_published_state(
        &state_dir,
        &repo,
        Some("test-version"),
        &published_state(&repo, &anchor, "scan-previous", (10, 5), "v1", &anchor),
    );
    let clock = Arc::new(AtomicI64::new(now));
    let worker = Arc::new(cadence_worker(&repo, FixtureForge::default(), clock));
    assert!(worker.start("acme/fixture"));
    let ticks = tick_thread(Arc::clone(&worker));
    assert_eq!(
        worker.current_state().last_scan_started_at.as_deref(),
        Some(anchor.as_str()),
        "the published run start is the inherited cadence anchor"
    );

    a_tick_within_five_seconds(&ticks, "the cadence tick").await;

    let state = worker.current_state();
    assert_eq!(
        state.last_scan_started_at.as_deref(),
        Some(devboard::workers::scout::iso_from_millis(now).as_str()),
        "the elapsed cadence publishes a new run start"
    );
    assert_eq!(state.lifecycle, "idle");
    assert_eq!(scan_ids(&repo).len(), 1, "one scan started");
    worker.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_completed_run_keeps_the_cadence_and_a_later_tick_consumes_a_control() {
    let repo = scratch("cadence-after-run");
    let state_dir = repo.join(".devboard").join("state");
    let now = 1_780_000_000_000i64;
    let clock = Arc::new(AtomicI64::new(now));
    let worker = Arc::new(cadence_worker(
        &repo,
        FixtureForge::default(),
        Arc::clone(&clock),
    ));
    assert!(worker.start("acme/fixture"));
    let ticks = tick_thread(Arc::clone(&worker));

    a_tick_within_five_seconds(&ticks, "the first run").await;
    assert_eq!(scan_ids(&repo).len(), 1, "the first run starts");
    let first_start = worker
        .current_state()
        .last_scan_started_at
        .clone()
        .expect("the completed run records its start");

    clock.store(now + 30_000, Ordering::SeqCst);
    a_tick_within_five_seconds(&ticks, "the tick inside the cadence").await;
    assert_eq!(scan_ids(&repo).len(), 1, "the cadence gate still holds");

    clock.store(now + 120_000, Ordering::SeqCst);
    a_tick_within_five_seconds(&ticks, "the tick after the cadence").await;
    assert_eq!(
        scan_ids(&repo).len(),
        2,
        "the elapsed cadence starts the next run"
    );
    assert_ne!(
        worker.current_state().last_scan_started_at.as_deref(),
        Some(first_start.as_str()),
        "the next run publishes its own start"
    );

    let control = versioned_control_directory(&state_dir, &repo, Some("test-version"));
    write_command(
        &control,
        &ScoutCommand::Settings {
            interval_minutes: 7,
            max_per_hour: Some(2),
            max_pending: Some(3),
        },
    )
    .expect("a settings command");
    a_tick_within_five_seconds(&ticks, "the tick after the control").await;
    assert_eq!(
        worker.current_state().interval_minutes,
        7,
        "the worker still consumes a control command after a run"
    );
    worker.stop().await;
}

#[tokio::test]
async fn a_new_version_inherits_the_newest_published_state() {
    let repo = scratch("inherit-newest");
    let state_dir = repo.join(".devboard").join("state");
    write_published_state(
        &state_dir,
        &repo,
        None,
        &published_state(
            &repo,
            "2026-01-01T00:00:00.000Z",
            "legacy-scan",
            (11, 2),
            "legacy",
            "2026-01-01T00:00:00.000Z",
        ),
    );
    write_published_state(
        &state_dir,
        &repo,
        Some("0.0.1"),
        &published_state(
            &repo,
            "2026-01-02T00:00:00.000Z",
            "v1-scan",
            (22, 3),
            "v1",
            "2026-01-02T00:00:00.000Z",
        ),
    );
    write_published_state(
        &state_dir,
        &repo,
        Some("0.0.2"),
        &published_state(
            &repo,
            "2026-01-03T00:00:00.000Z",
            "v2-scan",
            (33, 4),
            "v2",
            "2026-01-03T00:00:00.000Z",
        ),
    );
    let worker = worker(
        &repo,
        FixtureForge::default(),
        Arc::new(|_context| Box::pin(async { Ok(()) })),
    );
    assert!(worker.start("acme/fixture"));

    let state = worker.current_state();
    assert_eq!(
        state.last_scan_started_at.as_deref(),
        Some("2026-01-03T00:00:00.000Z"),
        "the newest cadence anchor is inherited"
    );
    assert_eq!(state.newest_scan_id.as_deref(), Some("v2-scan"));
    assert_eq!(state.limits.max_per_hour, Some(33));
    assert_eq!(state.limits.max_pending, Some(4));
    assert_eq!(state.release_signature.as_deref(), Some("v2"));
    assert_eq!(
        state.sync.at.as_deref(),
        Some("2026-01-03T00:00:00.000Z"),
        "the newest sync instant is inherited"
    );
    let published = read_state(&versioned_state_path(
        &state_dir,
        &repo,
        Some("test-version"),
    ))
    .expect("the published state");
    assert_eq!(published.newest_scan_id.as_deref(), Some("v2-scan"));
    assert_eq!(published.limits.max_per_hour, Some(33));
    worker.stop().await;
}

#[tokio::test]
async fn a_newer_versioned_state_outranks_the_legacy_file() {
    let repo = scratch("inherit-precedence");
    let state_dir = repo.join(".devboard").join("state");
    write_published_state(
        &state_dir,
        &repo,
        None,
        &published_state(
            &repo,
            "2026-01-01T00:00:00.000Z",
            "legacy-scan",
            (11, 2),
            "legacy",
            "2026-01-01T00:00:00.000Z",
        ),
    );
    write_published_state(
        &state_dir,
        &repo,
        Some("0.0.1"),
        &published_state(
            &repo,
            "2026-01-05T00:00:00.000Z",
            "v1-scan",
            (22, 3),
            "v1",
            "2026-01-05T00:00:00.000Z",
        ),
    );
    let newer_worker = worker(
        &repo,
        FixtureForge::default(),
        Arc::new(|_context| Box::pin(async { Ok(()) })),
    );
    assert!(newer_worker.start("acme/fixture"));
    let state = newer_worker.current_state();
    assert_eq!(
        state.last_scan_started_at.as_deref(),
        Some("2026-01-05T00:00:00.000Z"),
        "the newer versioned anchor wins"
    );
    assert_eq!(state.newest_scan_id.as_deref(), Some("v1-scan"));
    assert_eq!(state.limits.max_per_hour, Some(22));
    assert_eq!(state.limits.max_pending, Some(3));
    assert_eq!(state.release_signature.as_deref(), Some("v1"));
    newer_worker.stop().await;

    let legacy_only = scratch("inherit-legacy-only");
    let legacy_state_dir = legacy_only.join(".devboard").join("state");
    write_published_state(
        &legacy_state_dir,
        &legacy_only,
        None,
        &published_state(
            &legacy_only,
            "2026-01-01T00:00:00.000Z",
            "legacy-scan",
            (11, 2),
            "legacy",
            "2026-01-01T00:00:00.000Z",
        ),
    );
    let legacy_worker = worker(
        &legacy_only,
        FixtureForge::default(),
        Arc::new(|_context| Box::pin(async { Ok(()) })),
    );
    assert!(legacy_worker.start("acme/fixture"));
    let state = legacy_worker.current_state();
    assert_eq!(
        state.last_scan_started_at.as_deref(),
        Some("2026-01-01T00:00:00.000Z"),
        "the legacy file is used when it is the only state"
    );
    assert_eq!(state.newest_scan_id.as_deref(), Some("legacy-scan"));
    assert_eq!(state.limits.max_per_hour, Some(11));
    assert_eq!(state.release_signature.as_deref(), Some("legacy"));
    legacy_worker.stop().await;
}

#[tokio::test]
async fn a_version_keeps_its_own_published_state() {
    let repo = scratch("inherit-own");
    let state_dir = repo.join(".devboard").join("state");
    write_published_state(
        &state_dir,
        &repo,
        None,
        &published_state(
            &repo,
            "2026-01-04T00:00:00.000Z",
            "legacy-scan",
            (11, 2),
            "legacy",
            "2026-01-04T00:00:00.000Z",
        ),
    );
    write_published_state(
        &state_dir,
        &repo,
        Some("0.0.1"),
        &published_state(
            &repo,
            "2026-01-05T00:00:00.000Z",
            "v1-scan",
            (22, 3),
            "v1",
            "2026-01-05T00:00:00.000Z",
        ),
    );
    write_published_state(
        &state_dir,
        &repo,
        Some("test-version"),
        &published_state(
            &repo,
            "2026-01-02T00:00:00.000Z",
            "own-scan",
            (44, 5),
            "own",
            "2026-01-02T00:00:00.000Z",
        ),
    );
    let worker = worker(
        &repo,
        FixtureForge::default(),
        Arc::new(|_context| Box::pin(async { Ok(()) })),
    );
    assert!(worker.start("acme/fixture"));
    let state = worker.current_state();
    assert_eq!(
        state.last_scan_started_at.as_deref(),
        Some("2026-01-02T00:00:00.000Z"),
        "the version's own anchor is kept whatever other timestamps say"
    );
    assert_eq!(state.newest_scan_id.as_deref(), Some("own-scan"));
    assert_eq!(state.limits.max_per_hour, Some(44));
    assert_eq!(state.release_signature.as_deref(), Some("own"));
    worker.stop().await;
}
