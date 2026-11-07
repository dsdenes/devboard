//! The Release Train worker: the gate, the singleton, the cadence, failed
//! runs, drain, and the durable files under the state directory.
//!
//! Every fixture is a real Git repository with a local bare `origin`; every
//! release run and verification is injected, so no test contacts a network.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::json;

use devboard::forge::{gitea_git_credential, GiteaGitCredential};
use devboard::publish::{
    PublishArgs, PublishReport, SourceRefreshReport, SourceRefreshRequest, MANIFEST_CHECKSUM_ASSET,
    RELEASE_INSTALLERS, RELEASE_TARGETS,
};
use devboard::release::MANIFEST_ASSET;
use devboard::workers::release_train::{
    activity_path, check_release_train, empty_state, merge_state, parse_iso_millis, read_result,
    read_settings, read_state, read_worker_state, release_history, release_train_directory,
    release_train_owners, release_train_worker_states, request_path, run_directory, runs_directory,
    state_path, verify_shipped, versioned_control_directory, versioned_lock_path,
    versioned_worker_state_path, write_command, write_state, AgentLifecycle, Clock, ForgeRelease,
    GateGit, GitOutcome, PublishFuture, ReadRetry, ReleaseRunInput, ReleaseRunResult,
    ReleaseRunTimeouts, ReleaseTrainCommand, ReleaseTrainCommit, ReleaseTrainFailure,
    ReleaseTrainGate, ReleaseTrainGateOptions, ReleaseTrainRelease, ReleaseTrainRequest,
    ReleaseTrainRun, ReleaseTrainRunState, ReleaseTrainTag, ReleaseTrainWorker,
    ReleaseTrainWorkerOptions, ReleaseVerification, ReleaseVerificationOptions,
    ReleaseVerificationPhase, RunFuture, RunReleaseFn, VerifyFn,
};

const START_ISO: &str = "2026-11-02T10:00:00.000Z";

fn start_ms() -> i64 {
    parse_iso_millis(START_ISO).expect("the fixture instant parses")
}

#[derive(Clone)]
struct FakeClock {
    millis: Arc<Mutex<i64>>,
}

impl FakeClock {
    fn new(millis: i64) -> Self {
        Self {
            millis: Arc::new(Mutex::new(millis)),
        }
    }

    fn now(&self) -> i64 {
        *self.millis.lock().expect("the clock")
    }

    fn set(&self, millis: i64) {
        *self.millis.lock().expect("the clock") = millis;
    }

    fn advance(&self, millis: i64) {
        *self.millis.lock().expect("the clock") += millis;
    }

    fn function(&self) -> Clock {
        let millis = self.millis.clone();
        Arc::new(move || *millis.lock().expect("the clock"))
    }
}

/* ------------------------------------------------------------------------ */
/* Git fixtures                                                              */
/* ------------------------------------------------------------------------ */

fn scratch_root(label: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("release-train-{label}-{}", std::process::id()))
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-c")
        .arg("user.name=Release Train Fixture")
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
    if !output.status.success() {
        panic!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

struct Fixture {
    root: PathBuf,
    repo: PathBuf,
}

fn fixture(label: &str, tagged: bool) -> Fixture {
    let root = scratch_root(label);
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("a fixture root");
    let origin = root.join("origin.git");
    let repo = root.join("repo");
    git(
        &root,
        &["init", "--bare", "-q", origin.to_str().expect("a path")],
    );
    std::fs::create_dir_all(&repo).expect("a checkout");
    git(&repo, &["init", "-q"]);
    git(&repo, &["symbolic-ref", "HEAD", "refs/heads/main"]);
    std::fs::write(repo.join("app.txt"), "one\n").expect("a file");
    git(&repo, &["add", "app.txt"]);
    git(&repo, &["commit", "-q", "-m", "chore: initial commit"]);
    if tagged {
        git(&repo, &["tag", "v1.0.0"]);
    }
    git(
        &repo,
        &["remote", "add", "origin", origin.to_str().expect("a path")],
    );
    git(&repo, &["push", "-q", "-u", "origin", "main"]);
    if tagged {
        git(&repo, &["push", "-q", "origin", "--tags"]);
    }
    Fixture { root, repo }
}

fn commit(repo: &Path, subject: &str) -> String {
    std::fs::write(repo.join("app.txt"), format!("{subject}\n")).expect("a file");
    git(repo, &["add", "app.txt"]);
    git(repo, &["commit", "-q", "-m", subject]);
    git(repo, &["push", "-q", "origin", "main"]);
    git(repo, &["rev-parse", "HEAD"])
}

struct Workspace {
    root: PathBuf,
    repo_dir: PathBuf,
    state_dir: PathBuf,
}

fn workspace(label: &str) -> Workspace {
    let root = scratch_root(label);
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("repo/.devboard")).expect("a checkout");
    std::fs::create_dir_all(root.join("state")).expect("a state directory");
    Workspace {
        repo_dir: root.join("repo"),
        state_dir: root.join("state"),
        root,
    }
}

/* ------------------------------------------------------------------------ */
/* The gate                                                                  */
/* ------------------------------------------------------------------------ */

#[tokio::test]
async fn a_tag_at_the_branch_tip_leaves_nothing_to_release() {
    let fixture = fixture("gate-released", true);
    let gate = check_release_train(&fixture.repo, ReleaseTrainGateOptions::default());
    match gate {
        ReleaseTrainGate::Nothing {
            target,
            previous,
            range,
        } => {
            assert_eq!(
                previous.as_ref().map(|tag| tag.tag.as_str()),
                Some("v1.0.0")
            );
            assert_eq!(target, git(&fixture.repo, &["rev-parse", "origin/main"]));
            assert_eq!(range, format!("v1.0.0..{target}"));
        }
        other => panic!("expected nothing, got {other:?}"),
    }
}

#[tokio::test]
async fn one_fix_after_the_newest_tag_is_unreleased() {
    let fixture = fixture("gate-one-fix", true);
    let sha = commit(&fixture.repo, "fix: correct the release gate");
    match check_release_train(&fixture.repo, ReleaseTrainGateOptions::default()) {
        ReleaseTrainGate::Unreleased {
            target,
            version,
            release_commits,
            ..
        } => {
            assert_eq!(target, sha);
            assert_eq!(version, "1.0.1");
            assert_eq!(release_commits.len(), 1);
            assert_eq!(release_commits[0].sha, sha);
            assert_eq!(release_commits[0].subject, "fix: correct the release gate");
            assert!(!release_commits[0].merge);
        }
        other => panic!("expected unreleased, got {other:?}"),
    }
}

#[tokio::test]
async fn only_merge_commits_after_the_tag_release_nothing() {
    let fixture = fixture("gate-merge-only", true);
    let tree = git(&fixture.repo, &["rev-parse", "HEAD^{tree}"]);
    let merge = git(
        &fixture.repo,
        &[
            "commit-tree",
            &tree,
            "-p",
            "HEAD",
            "-p",
            "HEAD",
            "-m",
            "Merge branch 'already-released'",
        ],
    );
    git(&fixture.repo, &["reset", "--hard", &merge]);
    git(&fixture.repo, &["push", "-q", "origin", "main"]);
    let gate = check_release_train(&fixture.repo, ReleaseTrainGateOptions::default());
    assert!(matches!(gate, ReleaseTrainGate::Nothing { .. }), "{gate:?}");
}

#[tokio::test]
async fn several_commits_after_an_older_tag_hand_over_the_range() {
    let fixture = fixture("gate-range", true);
    let first = commit(&fixture.repo, "fix: first correction");
    let second = commit(&fixture.repo, "feat: add the second behavior");
    match check_release_train(&fixture.repo, ReleaseTrainGateOptions::default()) {
        ReleaseTrainGate::Unreleased {
            version,
            range,
            release_commits,
            ..
        } => {
            assert_eq!(version, "1.1.0");
            assert_eq!(range, format!("v1.0.0..{second}"));
            let shas: Vec<&str> = release_commits
                .iter()
                .map(|entry| entry.sha.as_str())
                .collect();
            assert_eq!(shas, vec![second.as_str(), first.as_str()]);
        }
        other => panic!("expected unreleased, got {other:?}"),
    }
}

#[tokio::test]
async fn no_release_tag_makes_the_whole_history_unreleased() {
    let fixture = fixture("gate-no-tag", false);
    match check_release_train(&fixture.repo, ReleaseTrainGateOptions::default()) {
        ReleaseTrainGate::Unreleased {
            target,
            previous,
            range,
            version,
            ..
        } => {
            assert!(previous.is_none());
            assert_eq!(range, target);
            assert_eq!(version, "1.0.0");
        }
        other => panic!("expected unreleased, got {other:?}"),
    }
}

#[tokio::test]
async fn an_unreadable_remote_is_a_reported_failure() {
    let fixture = fixture("gate-bad-remote", true);
    let missing = fixture.root.join("missing.git");
    git(
        &fixture.repo,
        &[
            "remote",
            "set-url",
            "origin",
            missing.to_str().expect("a path"),
        ],
    );
    match check_release_train(&fixture.repo, ReleaseTrainGateOptions::default()) {
        ReleaseTrainGate::Error { detail } => {
            assert!(detail.contains("could not fetch origin/main"), "{detail}");
        }
        other => panic!("expected an error, got {other:?}"),
    }
}

#[tokio::test]
async fn an_unreadable_tag_list_is_a_reported_failure() {
    let fixture = fixture("gate-bad-tag", true);
    let real: GateGit = Arc::new({
        let repo = fixture.repo.clone();
        move |args: &[&str]| {
            let output = Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(args)
                .output()
                .expect("git runs");
            GitOutcome {
                code: output.status.code().unwrap_or(1),
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            }
        }
    });
    let options = ReleaseTrainGateOptions {
        run: Some(Arc::new(move |args: &[&str]| {
            if args.first() == Some(&"tag") {
                GitOutcome {
                    code: 1,
                    stdout: String::new(),
                    stderr: "fatal: cannot read the tag list".to_string(),
                }
            } else {
                real(args)
            }
        })),
        ..ReleaseTrainGateOptions::default()
    };
    match check_release_train(&fixture.repo, options) {
        ReleaseTrainGate::Error { detail } => {
            assert!(
                detail.contains("could not read the release tags"),
                "{detail}"
            );
            assert!(detail.contains("cannot read the tag list"), "{detail}");
        }
        other => panic!("expected an error, got {other:?}"),
    }
}

/* ------------------------------------------------------------------------ */
/* The worker                                                                */
/* ------------------------------------------------------------------------ */

fn gitea_environment() -> HashMap<String, String> {
    HashMap::from([
        (
            "DEVBOARD_GITEA_URL".to_string(),
            "http://localhost:3001".to_string(),
        ),
        ("GITEA_TOKEN".to_string(), "secret-token".to_string()),
    ])
}

#[test]
fn an_ssh_origin_resolves_the_configured_gitea_http_credential() {
    let fixture = fixture("gate-credential", true);
    git(
        &fixture.repo,
        &[
            "remote",
            "set-url",
            "origin",
            "ssh://ds@localhost:2223/dsdenes/devboard.git",
        ],
    );
    let credential = gitea_git_credential(&fixture.repo, &gitea_environment())
        .expect("an ssh origin resolves the configured credential");
    assert_eq!(credential.url, "http://localhost:3001/dsdenes/devboard.git");
    assert_eq!(
        credential.remote_url,
        "ssh://ds@localhost:2223/dsdenes/devboard.git"
    );
    assert_eq!(credential.base_url, "http://localhost:3001");
    assert_eq!(credential.header, "Authorization: token secret-token");
}

#[test]
fn an_http_origin_or_a_missing_token_resolves_no_credential() {
    let fixture = fixture("gate-no-credential", true);
    let without_token = HashMap::from([(
        "DEVBOARD_GITEA_URL".to_string(),
        "http://localhost:3001".to_string(),
    )]);
    let ssh = "ssh://ds@localhost:2223/dsdenes/devboard.git";
    git(&fixture.repo, &["remote", "set-url", "origin", ssh]);
    assert!(gitea_git_credential(&fixture.repo, &without_token).is_none());
    git(
        &fixture.repo,
        &[
            "remote",
            "set-url",
            "origin",
            "http://localhost:3001/dsdenes/devboard.git",
        ],
    );
    assert!(gitea_git_credential(&fixture.repo, &gitea_environment()).is_none());
}

#[tokio::test]
async fn the_gate_fetches_through_the_gitea_credential() {
    let fixture = fixture("gate-credential-fetch", true);
    git(
        &fixture.repo,
        &[
            "remote",
            "set-url",
            "origin",
            "ssh://ds@localhost:2223/dsdenes/devboard.git",
        ],
    );
    let options = ReleaseTrainGateOptions {
        credential: Some(GiteaGitCredential {
            url: fixture
                .root
                .join("origin.git")
                .to_string_lossy()
                .into_owned(),
            remote_url: "ssh://ds@localhost:2223/dsdenes/devboard.git".to_string(),
            base_url: "http://localhost:3001".to_string(),
            header: "Authorization: token secret-token".to_string(),
        }),
        ..ReleaseTrainGateOptions::default()
    };
    // The plain SSH origin cannot be fetched here; the credential redirects
    // the fetch to the local bare repository, so a successful gate proves the
    // override reached `git fetch`.
    let gate = check_release_train(&fixture.repo, options);
    assert!(matches!(gate, ReleaseTrainGate::Nothing { .. }), "{gate:?}");
}

/* ------------------------------------------------------------------------ */
/* The worker                                                                */
/* ------------------------------------------------------------------------ */

fn nothing_gate(target: &str) -> ReleaseTrainGate {
    ReleaseTrainGate::Nothing {
        target: target.to_string(),
        previous: Some(ReleaseTrainTag {
            tag: "v1.0.0".to_string(),
            version: "1.0.0".to_string(),
        }),
        range: format!("v1.0.0..{target}"),
    }
}

fn unreleased(target: &str, version: &str) -> ReleaseTrainGate {
    let commit = ReleaseTrainCommit {
        sha: target.to_string(),
        subject: "fix: release it".to_string(),
        merge: false,
    };
    ReleaseTrainGate::Unreleased {
        target: target.to_string(),
        previous: Some(ReleaseTrainTag {
            tag: "v1.0.0".to_string(),
            version: "1.0.0".to_string(),
        }),
        range: format!("v1.0.0..{target}"),
        version: version.to_string(),
        commits: vec![commit.clone()],
        release_commits: vec![commit],
    }
}

type GateFn = Arc<dyn Fn(&Path) -> Result<ReleaseTrainGate, String> + Send + Sync>;

fn gate_ok(gate: ReleaseTrainGate) -> GateFn {
    Arc::new(move |_repo| Ok(gate.clone()))
}

fn run_ok(runs: Arc<AtomicUsize>, version: &'static str) -> RunReleaseFn {
    Arc::new(move |input: ReleaseRunInput| -> RunFuture {
        runs.fetch_add(1, Ordering::SeqCst);
        (input.activity)("the agent released it");
        Box::pin(async move { ok_result(version) })
    })
}

fn ok_result(version: &str) -> ReleaseRunResult {
    ReleaseRunResult::Ok {
        version: version.to_string(),
        url: format!("https://forge.test/releases/tag/v{version}"),
    }
}

fn verify_ok() -> VerifyFn {
    Arc::new(|options: ReleaseVerificationOptions| {
        Box::pin(async move {
            ReleaseVerification::Ok {
                version: options.version.clone(),
                url: format!("https://forge.test/releases/tag/v{}", options.version),
            }
        })
    })
}

fn worker(
    workspace: &Workspace,
    version: &str,
    clock: &FakeClock,
    gate: GateFn,
    run: RunReleaseFn,
) -> ReleaseTrainWorker {
    let mut options = ReleaseTrainWorkerOptions::new(&workspace.repo_dir, &workspace.state_dir);
    options.harness_version = Some(version.to_string());
    options.manual = true;
    options.now = Some(clock.function());
    options.gate = Some(gate);
    options.run_release = Some(run);
    options.verify = Some(verify_ok());
    options.log = Some(Arc::new(|_line: &str| {}));
    ReleaseTrainWorker::new(options)
}

#[tokio::test]
async fn one_worker_per_version_refuses_a_second_start() {
    let workspace = workspace("singleton");
    let clock = FakeClock::new(start_ms());
    let runs = Arc::new(AtomicUsize::new(0));
    let target = "a".repeat(40);
    let first = worker(
        &workspace,
        "test-version",
        &clock,
        gate_ok(nothing_gate(&target)),
        run_ok(runs.clone(), "1.0.1"),
    );
    let second = worker(
        &workspace,
        "test-version",
        &clock,
        gate_ok(nothing_gate(&target)),
        run_ok(runs.clone(), "1.0.1"),
    );
    assert!(first.begin());
    assert!(
        !second.begin(),
        "a second worker of this version must refuse"
    );
    assert!(versioned_lock_path(
        &release_train_directory(&workspace.state_dir),
        Some("test-version")
    )
    .exists());
    first.stop().await;
    assert!(!versioned_lock_path(
        &release_train_directory(&workspace.state_dir),
        Some("test-version")
    )
    .exists());
    assert!(second.begin());
    second.stop().await;
    assert_eq!(runs.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_nothing_verdict_spawns_no_agent() {
    let workspace = workspace("nothing");
    let clock = FakeClock::new(start_ms());
    let runs = Arc::new(AtomicUsize::new(0));
    let target = "b".repeat(40);
    let worker = worker(
        &workspace,
        "test-version",
        &clock,
        gate_ok(nothing_gate(&target)),
        run_ok(runs.clone(), "1.0.0"),
    );
    assert!(worker.begin());
    worker.tick_now(true).await;
    worker.stop().await;
    assert_eq!(runs.load(Ordering::SeqCst), 0);
    let state = worker.current_state();
    assert!(state
        .activity
        .iter()
        .any(|line| line.contains("nothing to release")));
    assert!(state.runs.is_empty());
    assert_eq!(
        state.gate.as_ref().map(|gate| gate.state),
        Some(devboard::workers::release_train::ReleaseTrainGateState::Nothing)
    );
    assert!(state_path(&release_train_directory(&workspace.state_dir)).exists());
}

#[tokio::test]
async fn an_unreleased_verdict_starts_one_run_and_records_it() {
    let workspace = workspace("unreleased");
    let clock = FakeClock::new(start_ms());
    let runs = Arc::new(AtomicUsize::new(0));
    let target = "a".repeat(40);
    let worker = worker(
        &workspace,
        "test-version",
        &clock,
        gate_ok(unreleased(&target, "1.0.1")),
        run_ok(runs.clone(), "1.0.1"),
    );
    assert!(worker.begin());
    worker.tick_now(true).await;
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    let state = worker.current_state();
    let release = state.release.expect("a recorded release");
    assert_eq!(release.version, "1.0.1");
    assert_eq!(release.url, "https://forge.test/releases/tag/v1.0.1");
    assert_eq!(release.at, START_ISO);
    assert_eq!(release.sha, target);
    assert_eq!(release.range, format!("v1.0.0..{target}"));
    assert!(state.failure.is_none());
    assert_eq!(state.runs.len(), 1);
    assert_eq!(state.runs[0].state, ReleaseTrainRunState::Released);
    assert_eq!(state.runs[0].commits, Some(1));
    let run_id = state.runs[0].id.clone();
    assert!(state
        .activity
        .iter()
        .any(|line| line == "released v1.0.1: https://forge.test/releases/tag/v1.0.1"));
    assert!(state
        .activity
        .iter()
        .any(|line| line == "the agent released it"));

    let directory = release_train_directory(&workspace.state_dir);
    assert!(state_path(&directory).exists());
    assert_eq!(read_settings(&directory).interval_minutes, 10);
    let worker_path = versioned_worker_state_path(&directory, Some("test-version"));
    assert!(worker_path.exists());
    let request: Value = serde_json::from_str(
        &std::fs::read_to_string(request_path(&directory, &run_id)).expect("a request"),
    )
    .expect("request JSON");
    assert_eq!(request["format"], 1);
    assert_eq!(request["runId"], run_id);
    assert_eq!(request["range"], format!("v1.0.0..{target}"));
    assert_eq!(request["target"], target);
    assert_eq!(request["version"], "1.0.1");
    assert_eq!(request["previous"], "v1.0.0");
    assert_eq!(request["releaseCommits"].as_array().map(Vec::len), Some(1));
    let activity: Value = serde_json::from_str(
        &std::fs::read_to_string(activity_path(&directory, &run_id)).expect("run activity"),
    )
    .expect("activity JSON");
    assert!(activity
        .as_array()
        .expect("a list")
        .iter()
        .any(|line| line == "the agent released it"));

    let record = read_worker_state(&worker_path).expect("the worker record");
    assert_eq!(record.harness_version.as_deref(), Some("test-version"));
    assert_eq!(record.lifecycle, AgentLifecycle::Running);
    worker.stop().await;
    let stopped = read_worker_state(&worker_path).expect("the worker record");
    assert_eq!(stopped.lifecycle, AgentLifecycle::Stopped);
    assert!(!stopped.enabled);
}

#[tokio::test]
async fn a_failed_run_records_the_failure_and_retries_on_the_next_due_tick() {
    let workspace = workspace("retry");
    let clock = FakeClock::new(start_ms());
    let target = "a".repeat(40);
    let gates = Arc::new(AtomicUsize::new(0));
    let attempts = Arc::new(AtomicUsize::new(0));
    let gate = {
        let gates = gates.clone();
        let gate = unreleased(&target, "1.0.1");
        Arc::new(move |_repo: &Path| {
            gates.fetch_add(1, Ordering::SeqCst);
            Ok(gate.clone())
        }) as GateFn
    };
    let run: RunReleaseFn = {
        let attempts = attempts.clone();
        Arc::new(move |input: ReleaseRunInput| -> RunFuture {
            let attempt = attempts.fetch_add(1, Ordering::SeqCst);
            if attempt == 0 {
                (input.activity)("the agent failed");
                Box::pin(async move {
                    ReleaseRunResult::failed("the release workflow concluded failure")
                })
            } else {
                Box::pin(async move { ok_result("1.0.1") })
            }
        })
    };
    let worker = worker(&workspace, "test-version", &clock, gate, run);
    assert!(worker.begin());
    worker.tick_now(true).await;
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
    let state = worker.current_state();
    assert!(
        state.release.is_none(),
        "a failed run marks nothing released"
    );
    let failure = state.failure.clone().expect("a recorded failure");
    assert!(failure.detail.contains("concluded failure"));
    assert_eq!(failure.sha, target);
    assert_eq!(failure.range, format!("v1.0.0..{target}"));
    assert_eq!(failure.version.as_deref(), Some("1.0.1"));
    assert_eq!(state.runs[0].state, ReleaseTrainRunState::Failed);
    assert_eq!(
        state.runs[0].detail.as_deref(),
        Some(failure.detail.as_str())
    );
    let next_run_at = parse_iso_millis(
        worker
            .current_worker()
            .expect("a worker record")
            .next_run_at
            .as_deref()
            .expect("a due time"),
    )
    .expect("a due time parses");
    assert_eq!(next_run_at, start_ms() + 10 * 60_000);

    clock.advance(9 * 60_000);
    worker.tick_now(false).await;
    assert_eq!(gates.load(Ordering::SeqCst), 1, "not due yet");
    assert_eq!(attempts.load(Ordering::SeqCst), 1);

    clock.set(start_ms() + 10 * 60_000);
    worker.tick_now(false).await;
    assert_eq!(gates.load(Ordering::SeqCst), 2, "due after a full interval");
    assert_eq!(attempts.load(Ordering::SeqCst), 2);
    let state = worker.current_state();
    assert_eq!(
        state
            .release
            .as_ref()
            .map(|release| release.version.as_str()),
        Some("1.0.1")
    );
    assert!(
        state.failure.is_none(),
        "a later success clears the failure"
    );
    worker.stop().await;
}

#[tokio::test]
async fn a_thrown_gate_records_the_failure_and_holds_the_cadence() {
    let workspace = workspace("thrown-gate");
    let clock = FakeClock::new(start_ms());
    let gates = Arc::new(AtomicUsize::new(0));
    let gate = {
        let gates = gates.clone();
        Arc::new(move |_repo: &Path| {
            gates.fetch_add(1, Ordering::SeqCst);
            Err("could not read the release state".to_string())
        }) as GateFn
    };
    let runs = Arc::new(AtomicUsize::new(0));
    let worker = worker(
        &workspace,
        "test-version",
        &clock,
        gate,
        run_ok(runs.clone(), "1.0.1"),
    );
    assert!(worker.begin());
    worker.tick_now(true).await;
    assert_eq!(gates.load(Ordering::SeqCst), 1);
    assert_eq!(runs.load(Ordering::SeqCst), 0);
    let state = worker.current_state();
    assert_eq!(
        state
            .failure
            .as_ref()
            .map(|failure| failure.detail.as_str()),
        Some("could not read the release state")
    );
    let record = worker.current_worker().expect("a worker record");
    assert_eq!(
        record.last_error.as_deref(),
        Some("could not read the release state")
    );
    assert_eq!(record.lifecycle, AgentLifecycle::Failed);
    assert!(state
        .activity
        .iter()
        .any(|line| line == "release train tick failed: could not read the release state"));
    let next_run_at = parse_iso_millis(record.next_run_at.as_deref().expect("a due time"))
        .expect("a due time parses");
    assert!(next_run_at - clock.now() >= 10 * 60_000);

    clock.advance(1_000);
    worker.tick_now(false).await;
    assert_eq!(gates.load(Ordering::SeqCst), 1, "inside the interval");
    clock.set(next_run_at);
    worker.tick_now(false).await;
    assert_eq!(
        gates.load(Ordering::SeqCst),
        2,
        "the next due tick gates again"
    );
    worker.stop().await;
}

#[tokio::test]
async fn a_run_directory_that_cannot_be_created_fails_the_tick_without_wedging() {
    let workspace = workspace("thrown-run-dir");
    let clock = FakeClock::new(start_ms());
    let target = "a".repeat(40);
    let gates = Arc::new(AtomicUsize::new(0));
    let runs = Arc::new(AtomicUsize::new(0));
    let gate = {
        let gates = gates.clone();
        let gate = unreleased(&target, "1.0.1");
        Arc::new(move |_repo: &Path| {
            gates.fetch_add(1, Ordering::SeqCst);
            Ok(gate.clone())
        }) as GateFn
    };
    let worker = worker(
        &workspace,
        "test-version",
        &clock,
        gate,
        run_ok(runs.clone(), "1.0.1"),
    );
    assert!(worker.begin());
    let directory = release_train_directory(&workspace.state_dir);
    std::fs::write(runs_directory(&directory), "").expect("a regular file where runs belong");
    worker.tick_now(true).await;
    assert_eq!(runs.load(Ordering::SeqCst), 0);
    let state = worker.current_state();
    let failure = state.failure.clone().expect("a recorded failure");
    assert!(
        failure.detail.to_lowercase().contains("not a directory"),
        "{}",
        failure.detail
    );
    assert_eq!(failure.sha, target);
    assert_eq!(failure.version.as_deref(), Some("1.0.1"));
    assert_eq!(state.runs[0].state, ReleaseTrainRunState::Failed);
    assert_eq!(worker.current_worker().expect("a record").active_run, None);
    let next_run_at = parse_iso_millis(
        worker
            .current_worker()
            .expect("a record")
            .next_run_at
            .as_deref()
            .expect("a due time"),
    )
    .expect("a due time parses");
    clock.advance(1_000);
    worker.tick_now(false).await;
    assert_eq!(gates.load(Ordering::SeqCst), 1);
    assert_eq!(runs.load(Ordering::SeqCst), 0);
    std::fs::remove_file(runs_directory(&directory)).expect("remove the blocker");
    clock.set(next_run_at);
    worker.tick_now(false).await;
    assert_eq!(gates.load(Ordering::SeqCst), 2);
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    assert!(worker.current_state().failure.is_none());
    worker.stop().await;
}

#[tokio::test]
async fn a_tick_during_an_active_run_starts_no_second_run() {
    let workspace = workspace("active-run");
    let clock = FakeClock::new(start_ms());
    let target = "a".repeat(40);
    let runs = Arc::new(AtomicUsize::new(0));
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let started_tx = Arc::new(Mutex::new(Some(started_tx)));
    let release = Arc::new(tokio::sync::Notify::new());
    let run: RunReleaseFn = {
        let runs = runs.clone();
        let release = release.clone();
        Arc::new(move |_input: ReleaseRunInput| -> RunFuture {
            runs.fetch_add(1, Ordering::SeqCst);
            if let Some(sender) = started_tx.lock().expect("the sender").take() {
                let _ = sender.send(());
            }
            let release = release.clone();
            Box::pin(async move {
                release.notified().await;
                ok_result("1.0.1")
            })
        })
    };
    let worker = Arc::new(worker(
        &workspace,
        "test-version",
        &clock,
        gate_ok(unreleased(&target, "1.0.1")),
        run,
    ));
    assert!(worker.begin());
    let first = {
        let worker = worker.clone();
        tokio::spawn(async move { worker.tick_now(true).await })
    };
    started_rx.await.expect("the run started");
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    worker.tick_now(true).await;
    assert_eq!(
        runs.load(Ordering::SeqCst),
        1,
        "a second tick starts nothing"
    );
    release.notify_one();
    first.await.expect("the first tick");
    assert_eq!(
        worker
            .current_state()
            .release
            .map(|release| release.version),
        Some("1.0.1".to_string())
    );
    worker.stop().await;
}

#[tokio::test]
async fn drain_stops_after_the_active_run_and_publishes_stopped_state() {
    let workspace = workspace("drain");
    let clock = FakeClock::new(start_ms());
    let runs = Arc::new(AtomicUsize::new(0));
    let worker = worker(
        &workspace,
        "test-version",
        &clock,
        gate_ok(unreleased(&"c".repeat(40), "1.0.1")),
        run_ok(runs.clone(), "1.0.1"),
    );
    assert!(worker.begin());
    let directory = release_train_directory(&workspace.state_dir);
    let control = versioned_control_directory(&directory, Some("test-version"));
    write_command(&control, &ReleaseTrainCommand::Drain).expect("a drain command");
    worker.consume();
    assert!(worker.is_stopping(), "drain ends the worker after its run");
    assert_eq!(
        worker.current_worker().expect("a record").notice.as_deref(),
        Some("draining after the active run")
    );
    worker.tick_now(true).await;
    assert_eq!(
        runs.load(Ordering::SeqCst),
        0,
        "a draining worker starts nothing"
    );
    worker.stop().await;
    let record = read_worker_state(&versioned_worker_state_path(
        &directory,
        Some("test-version"),
    ))
    .expect("the worker record");
    assert_eq!(record.lifecycle, AgentLifecycle::Stopped);
    assert!(!record.enabled);
    assert!(!versioned_lock_path(&directory, Some("test-version")).exists());
    assert!(!release_train_owners(&directory)
        .iter()
        .any(|owner| owner.pid == std::process::id()
            && owner.harness_version.as_deref() == Some("test-version")));
}

#[tokio::test]
async fn two_versions_coexist_and_a_takeover_keeps_the_older_release() {
    let workspace = workspace("takeover");
    let clock = FakeClock::new(start_ms());
    let target = "a".repeat(40);
    let older = worker(
        &workspace,
        "0.0.9",
        &clock,
        gate_ok(unreleased(&target, "1.0.1")),
        {
            Arc::new(|input: ReleaseRunInput| -> RunFuture {
                (input.activity)("the older worker published the release");
                Box::pin(async move { ok_result("1.0.1") })
            })
        },
    );
    let newer_clock = FakeClock::new(start_ms() + 5_000);
    let newer = worker(
        &workspace,
        "1.0.0",
        &newer_clock,
        gate_ok(nothing_gate(&"d".repeat(40))),
        Arc::new(|_input: ReleaseRunInput| -> RunFuture {
            Box::pin(async move { ReleaseRunResult::failed("must not run") })
        }),
    );
    assert!(older.begin());
    assert!(newer.begin());
    let directory = release_train_directory(&workspace.state_dir);
    assert!(versioned_worker_state_path(&directory, Some("0.0.9")).exists());
    assert!(versioned_worker_state_path(&directory, Some("1.0.0")).exists());
    assert_eq!(release_train_worker_states(&directory).len(), 2);
    assert!(release_train_owners(&directory).len() >= 2);
    assert!(older.current_state().runs.is_empty());

    older.tick_now(true).await;
    let released_id = older.current_state().runs[0].id.clone();
    assert_eq!(
        older.current_state().runs[0].state,
        ReleaseTrainRunState::Released
    );
    assert!(newer.current_state().runs.is_empty());
    newer.tick_now(true).await;

    let reloaded = read_state(&directory).expect("the merged state");
    assert_eq!(
        reloaded
            .release
            .as_ref()
            .map(|release| release.version.as_str()),
        Some("1.0.1")
    );
    let row = reloaded
        .runs
        .iter()
        .find(|run| run.id == released_id)
        .expect("the older run survives the takeover");
    assert_eq!(row.state, ReleaseTrainRunState::Released);
    let activity = reloaded.activity.join("\n");
    assert!(activity.contains("released v1.0.1: https://forge.test/releases/tag/v1.0.1"));
    assert!(activity.contains("the older worker published the release"));
    assert!(activity.contains("nothing to release"));
    older.stop().await;
    newer.stop().await;
    let stopped = read_state(&directory).expect("the final state");
    assert_eq!(
        stopped
            .release
            .as_ref()
            .map(|release| release.version.as_str()),
        Some("1.0.1")
    );
}

#[tokio::test]
async fn a_recorded_failure_whose_tag_now_exists_is_verified_not_re_released() {
    let workspace = workspace("repair-tag");
    let repo = &workspace.repo_dir;
    git(repo, &["init", "-q"]);
    git(
        repo,
        &["commit", "--allow-empty", "-q", "-m", "fix: the release"],
    );
    let first = git(repo, &["rev-parse", "HEAD"]);
    git(
        repo,
        &[
            "commit",
            "--allow-empty",
            "-q",
            "-m",
            "fix: the next change",
        ],
    );
    let tip = git(repo, &["rev-parse", "HEAD"]);
    git(repo, &["tag", "v1.0.1", &first]);
    let directory = release_train_directory(&workspace.state_dir);
    let mut state = empty_state("", repo.to_str().expect("a path"), start_ms());
    state.failure = Some(ReleaseTrainFailure {
        at: "2026-11-02T09:00:00.000Z".to_string(),
        detail: "the release workflow concluded failure".to_string(),
        sha: first.clone(),
        range: format!("v1.0.0..{first}"),
        version: Some("1.0.1".to_string()),
    });
    write_state(&directory, &state).expect("the seeded state");

    let clock = FakeClock::new(start_ms());
    let runs = Arc::new(AtomicUsize::new(0));
    let verifications = Arc::new(AtomicUsize::new(0));
    let mut options = ReleaseTrainWorkerOptions::new(repo, &workspace.state_dir);
    options.harness_version = Some("test-version".to_string());
    options.manual = true;
    options.now = Some(clock.function());
    options.gate = Some(gate_ok(ReleaseTrainGate::Nothing {
        target: tip.clone(),
        previous: Some(ReleaseTrainTag {
            tag: "v1.0.1".to_string(),
            version: "1.0.1".to_string(),
        }),
        range: format!("v1.0.1..{tip}"),
    }));
    options.run_release = Some(run_ok(runs.clone(), "9.9.9"));
    options.verify = Some({
        let verifications = verifications.clone();
        Arc::new(move |options: ReleaseVerificationOptions| -> Pin<
            Box<dyn Future<Output = ReleaseVerification> + Send>,
        > {
            verifications.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                ReleaseVerification::Ok {
                    version: options.version.clone(),
                    url: "https://forge.test/releases/tag/v1.0.1".to_string(),
                }
            })
        }) as VerifyFn
    });
    options.log = Some(Arc::new(|_line: &str| {}));
    let worker = ReleaseTrainWorker::new(options);
    assert!(worker.begin());
    worker.tick_now(true).await;
    assert_eq!(runs.load(Ordering::SeqCst), 0, "no second release");
    assert_eq!(verifications.load(Ordering::SeqCst), 1);
    let state = worker.current_state();
    assert_eq!(
        state
            .release
            .as_ref()
            .map(|release| release.version.as_str()),
        Some("1.0.1")
    );
    assert!(state.failure.is_none());
    assert_eq!(state.runs[0].state, ReleaseTrainRunState::Released);
    worker.stop().await;
}

#[tokio::test]
async fn a_recovery_verifies_the_release_publish_actually_proved() {
    let workspace = workspace("recovery-version");
    let repo = &workspace.repo_dir;
    git(repo, &["init", "-q"]);
    git(
        repo,
        &["commit", "--allow-empty", "-q", "-m", "fix: the release"],
    );
    let first = git(repo, &["rev-parse", "HEAD"]);
    git(
        repo,
        &[
            "commit",
            "--allow-empty",
            "-q",
            "-m",
            "fix: the next change",
        ],
    );
    let tip = git(repo, &["rev-parse", "HEAD"]);
    git(repo, &["tag", "v1.0.1", &first]);
    git(repo, &["tag", "v1.0.2", &tip]);
    let directory = release_train_directory(&workspace.state_dir);
    let mut state = empty_state("", repo.to_str().expect("a path"), start_ms());
    state.failure = Some(ReleaseTrainFailure {
        at: "2026-11-02T09:00:00.000Z".to_string(),
        detail: "GitHub assets: the release v1.0.1 does not exist".to_string(),
        sha: first.clone(),
        range: format!("v1.0.0..{first}"),
        version: Some("1.0.1".to_string()),
    });
    write_state(&directory, &state).expect("the seeded state");

    let clock = FakeClock::new(start_ms());
    let publishes = Arc::new(AtomicUsize::new(0));
    let verified = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
    let mut options = ReleaseTrainWorkerOptions::new(repo, &workspace.state_dir);
    options.harness_version = Some("test-version".to_string());
    options.manual = true;
    options.now = Some(clock.function());
    options.gate = Some(gate_ok(ReleaseTrainGate::Nothing {
        target: tip.clone(),
        previous: Some(ReleaseTrainTag {
            tag: "v1.0.2".to_string(),
            version: "1.0.2".to_string(),
        }),
        range: format!("v1.0.2..{tip}"),
    }));
    options.publish = Some({
        let publishes = publishes.clone();
        let commit = tip.clone();
        Arc::new(move |_args: PublishArgs| -> PublishFuture {
            publishes.fetch_add(1, Ordering::SeqCst);
            let commit = commit.clone();
            Box::pin(async move {
                Ok(PublishReport {
                    version: "1.0.2".to_string(),
                    tag: "v1.0.2".to_string(),
                    commit,
                    published: true,
                    workflow_run: None,
                    github_assets: Vec::new(),
                    manifest: String::new(),
                    source_refresh: SourceRefreshReport {
                        request: SourceRefreshRequest {
                            schema: 1,
                            commit: String::new(),
                            version: String::new(),
                            dist_digest: String::new(),
                            requested_at: String::new(),
                        },
                        written: Vec::new(),
                        applied: Vec::new(),
                        failed: Vec::new(),
                    },
                    dashboards: Vec::new(),
                })
            })
        })
    });
    options.verify = Some({
        let verified = verified.clone();
        Arc::new(move |options: ReleaseVerificationOptions| -> Pin<
            Box<dyn Future<Output = ReleaseVerification> + Send>,
        > {
            verified
                .lock()
                .expect("the verifications")
                .push((options.target.clone(), options.version.clone()));
            Box::pin(async move {
                if options.version == "1.0.1" {
                    ReleaseVerification::Failed {
                        phase: ReleaseVerificationPhase::Github,
                        version: options.version.clone(),
                        detail: "GitHub assets: the release v1.0.1 does not exist".to_string(),
                    }
                } else {
                    ReleaseVerification::Ok {
                        version: options.version.clone(),
                        url: format!("https://forge.test/releases/tag/v{}", options.version),
                    }
                }
            })
        }) as VerifyFn
    });
    options.log = Some(Arc::new(|_line: &str| {}));
    let worker = ReleaseTrainWorker::new(options);
    assert!(worker.begin());
    worker.tick_now(true).await;

    assert_eq!(publishes.load(Ordering::SeqCst), 1);
    assert_eq!(
        verified.lock().expect("the verifications").clone(),
        vec![
            (first.clone(), "1.0.1".to_string()),
            (tip.clone(), "1.0.2".to_string())
        ],
        "the recovery verifies the published release, never the handed version"
    );
    let state = worker.current_state();
    assert_eq!(
        state
            .release
            .as_ref()
            .map(|release| release.version.as_str()),
        Some("1.0.2")
    );
    assert!(state.failure.is_none(), "the recovery clears the failure");
    assert!(
        state
            .runs
            .iter()
            .any(|run| run.state == ReleaseTrainRunState::Released),
        "the recovery settles as a release"
    );
    assert!(
        state.activity.iter().any(|line| line
            == "publish released v1.0.2 instead of the requested v1.0.1; verifying the published release"),
        "{:?}",
        state.activity
    );
    worker.stop().await;
}

/// A publish that failed withdraws the tag it created, so the verification's
/// tag phase reads that withdrawal back as a missing tag. The recorded failure
/// must name the publish error alone, never a phantom second failure beside it.
#[tokio::test]
async fn a_failed_publish_records_its_error_without_the_withdrawn_tag_phase() {
    let workspace = workspace("withdrawn-tag");
    let target = "c".repeat(40);
    let clock = FakeClock::new(start_ms());
    let mut options = ReleaseTrainWorkerOptions::new(&workspace.repo_dir, &workspace.state_dir);
    options.harness_version = Some("test-version".to_string());
    options.manual = true;
    options.now = Some(clock.function());
    options.gate = Some(gate_ok(unreleased(&target, "1.0.1")));
    options.publish = Some(Arc::new(|_args: PublishArgs| -> PublishFuture {
        Box::pin(async move {
            Err(anyhow::anyhow!(
                "the release workflow concluded failure: host failed at Create GitHub Release"
            ))
        })
    }));
    options.verify = Some(Arc::new(
        |options: ReleaseVerificationOptions| -> Pin<
            Box<dyn Future<Output = ReleaseVerification> + Send>,
        > {
            Box::pin(async move {
                ReleaseVerification::Failed {
                    phase: ReleaseVerificationPhase::Tag,
                    version: options.version.clone(),
                    detail: format!(
                        "tag binding: no release tag names or contains {} for v{}",
                        &options.target[..7],
                        options.version
                    ),
                }
            })
        },
    ));
    options.log = Some(Arc::new(|_line: &str| {}));
    let worker = ReleaseTrainWorker::new(options);
    assert!(worker.begin());
    worker.tick_now(true).await;
    let state = worker.current_state();
    let failure = state.failure.clone().expect("a recorded failure");
    assert_eq!(
        failure.detail,
        "the release workflow concluded failure: host failed at Create GitHub Release"
    );
    assert!(
        !failure.detail.contains("tag binding:"),
        "{}",
        failure.detail
    );
    assert_eq!(state.runs[0].state, ReleaseTrainRunState::Failed);
    worker.stop().await;
}

/// A peer that reported a failed publish never created the tag naming the
/// target, so the verification's tag phase reads that absence back. The record
/// of the release agent's run must name the peer's report alone, never a
/// phantom tag failure beside it.
#[tokio::test(flavor = "multi_thread")]
async fn a_peer_reported_failure_records_its_report_without_the_withdrawn_tag_phase() {
    let root = scratch_root("agent-withdrawn-tag");
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).expect("a repo");
    let run_dir = root.join("run");
    std::fs::create_dir_all(&run_dir).expect("a run directory");
    let report = "release suite: structural failure (compile error), nothing tagged or \
                  dispatched: No space left on device";
    std::fs::write(
        run_dir.join("result.json"),
        serde_json::json!({"ok": false, "detail": report}).to_string(),
    )
    .expect("the result document");
    let input = ReleaseRunInput {
        request: ReleaseTrainRequest {
            format: 1,
            run_id: "run-1".to_string(),
            range: "v1.0.0..abc".to_string(),
            target: "a".repeat(40),
            version: "1.0.0".to_string(),
            previous: Some("v1.0.0".to_string()),
            commits: Vec::new(),
            release_commits: Vec::new(),
        },
        activity: Arc::new(|_line: &str| {}),
        stopping: Arc::new(|| false),
        run_dir: run_dir.clone(),
        repo_dir: repo.clone(),
        state_dir: root.join("state"),
        agent_command: format!("{} acp-stub", env!("CARGO_BIN_EXE_devboard")),
        timeouts: ReleaseRunTimeouts::default(),
        register_peer: Arc::new(|_peer| {}),
    };
    let verify: VerifyFn = Arc::new(|options| {
        Box::pin(async move {
            ReleaseVerification::Failed {
                phase: ReleaseVerificationPhase::Tag,
                version: options.version.clone(),
                detail: format!(
                    "tag binding: no release tag names or contains {} for v{}",
                    &options.target[..7],
                    options.version
                ),
            }
        })
    });
    let run = devboard::workers::release_train::default_release_agent_runner(
        verify,
        std::collections::HashMap::new(),
    );
    let result = tokio::time::timeout(std::time::Duration::from_secs(60), run(input))
        .await
        .expect("the stub agent ends the run");
    assert_eq!(result, ReleaseRunResult::failed(report));
}

#[tokio::test]
async fn release_history_reads_the_request_of_a_legacy_run() {
    let workspace = workspace("history");
    let directory = release_train_directory(&workspace.state_dir);
    let legacy = run_directory(&directory, "legacy");
    std::fs::create_dir_all(&legacy).expect("a run directory");
    std::fs::write(
        request_path(&directory, "legacy"),
        serde_json::to_string(&ReleaseTrainRequest {
            format: 1,
            run_id: "legacy".to_string(),
            range: format!("v1.0.0..{}", "a".repeat(40)),
            target: "a".repeat(40),
            version: "1.0.0".to_string(),
            previous: None,
            commits: Vec::new(),
            release_commits: vec![
                ReleaseTrainCommit {
                    sha: "b".to_string(),
                    subject: "fix: b".to_string(),
                    merge: false,
                },
                ReleaseTrainCommit {
                    sha: "c".to_string(),
                    subject: "fix: c".to_string(),
                    merge: false,
                },
            ],
        })
        .expect("request JSON"),
    )
    .expect("the legacy request");
    let mut state = empty_state("", &workspace.root.to_string_lossy(), start_ms());
    state.runs = vec![
        ReleaseTrainRun {
            id: "legacy".to_string(),
            started_at: "2026-11-02T09:00:00.000Z".to_string(),
            ended_at: Some("2026-11-02T09:30:00.000Z".to_string()),
            state: ReleaseTrainRunState::Released,
            range: format!("v1.0.0..{}", "a".repeat(40)),
            target: "a".repeat(40),
            version: Some("1.0.0".to_string()),
            url: Some("https://forge.test/releases/tag/v1.0.0".to_string()),
            detail: None,
            commits: None,
            peer: None,
        },
        ReleaseTrainRun {
            id: "failed".to_string(),
            started_at: "2026-11-02T09:00:00.000Z".to_string(),
            ended_at: Some("2026-11-02T09:10:00.000Z".to_string()),
            state: ReleaseTrainRunState::Failed,
            range: "v1.0.0..abc".to_string(),
            target: "abc".to_string(),
            version: Some("2.0.0".to_string()),
            url: None,
            detail: Some("no".to_string()),
            commits: None,
            peer: None,
        },
    ];
    let rows = release_history(
        &directory,
        &serde_json::to_value(&state).expect("state JSON"),
    );
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["version"], json!("1.0.0"));
    assert_eq!(rows[0]["commits"], json!(2));
    assert_eq!(
        rows[0]["url"],
        json!("https://forge.test/releases/tag/v1.0.0")
    );
}

#[test]
fn release_history_lists_the_newest_release_without_its_settled_run() {
    let workspace = workspace("history-newest");
    let directory = release_train_directory(&workspace.state_dir);
    let running = run_directory(&directory, "running");
    std::fs::create_dir_all(&running).expect("a run directory");
    std::fs::write(
        request_path(&directory, "running"),
        serde_json::to_string(&ReleaseTrainRequest {
            format: 1,
            run_id: "running".to_string(),
            range: format!("v1.0.0..{}", "a".repeat(40)),
            target: "a".repeat(40),
            version: "1.1.0".to_string(),
            previous: Some("v1.0.0".to_string()),
            commits: Vec::new(),
            release_commits: vec![
                ReleaseTrainCommit {
                    sha: "b".to_string(),
                    subject: "fix: b".to_string(),
                    merge: false,
                },
                ReleaseTrainCommit {
                    sha: "c".to_string(),
                    subject: "fix: c".to_string(),
                    merge: false,
                },
                ReleaseTrainCommit {
                    sha: "d".to_string(),
                    subject: "fix: d".to_string(),
                    merge: false,
                },
            ],
        })
        .expect("request JSON"),
    )
    .expect("the running run's request");
    let mut state = empty_state("", &workspace.root.to_string_lossy(), start_ms());
    state.release = Some(ReleaseTrainRelease {
        version: "1.1.0".to_string(),
        url: "https://forge.test/releases/tag/v1.1.0".to_string(),
        at: "2026-11-02T10:30:00.000Z".to_string(),
        sha: "a".repeat(40),
        range: format!("v1.0.0..{}", "a".repeat(40)),
    });
    state.runs = vec![
        ReleaseTrainRun {
            id: "running".to_string(),
            started_at: "2026-11-02T10:00:00.000Z".to_string(),
            ended_at: None,
            state: ReleaseTrainRunState::Running,
            range: format!("v1.0.0..{}", "a".repeat(40)),
            target: "a".repeat(40),
            version: Some("1.1.0".to_string()),
            url: None,
            detail: None,
            commits: Some(3),
            peer: None,
        },
        ReleaseTrainRun {
            id: "settled".to_string(),
            started_at: "2026-11-02T09:00:00.000Z".to_string(),
            ended_at: Some("2026-11-02T09:30:00.000Z".to_string()),
            state: ReleaseTrainRunState::Released,
            range: format!("v0.9.0..{}", "e".repeat(40)),
            target: "e".repeat(40),
            version: Some("1.0.0".to_string()),
            url: Some("https://forge.test/releases/tag/v1.0.0".to_string()),
            detail: None,
            commits: Some(1),
            peer: None,
        },
    ];
    let rows = release_history(
        &directory,
        &serde_json::to_value(&state).expect("state JSON"),
    );
    assert_eq!(rows.len(), 2, "the newest release is listed exactly once");
    assert_eq!(rows[0]["version"], json!("1.1.0"));
    assert_eq!(rows[0]["at"], json!("2026-11-02T10:30:00.000Z"));
    assert_eq!(rows[0]["commits"], json!(3));
    assert_eq!(
        rows[0]["url"],
        json!("https://forge.test/releases/tag/v1.1.0")
    );
    assert_eq!(rows[1]["version"], json!("1.0.0"));
}

#[test]
fn merge_state_keeps_a_settled_run_over_a_stale_running_copy() {
    let run = |state: ReleaseTrainRunState, ended_at: Option<&str>| ReleaseTrainRun {
        id: "run-1".to_string(),
        started_at: "2026-11-02T10:00:00.000Z".to_string(),
        ended_at: ended_at.map(str::to_string),
        state,
        range: format!("v1.0.0..{}", "a".repeat(40)),
        target: "a".repeat(40),
        version: Some("1.1.0".to_string()),
        url: Some("https://forge.test/releases/tag/v1.1.0".to_string()),
        detail: None,
        commits: Some(1),
        peer: None,
    };
    let mut settled = empty_state("", "/repo", start_ms());
    settled.runs = vec![run(
        ReleaseTrainRunState::Released,
        Some("2026-11-02T10:30:00.000Z"),
    )];
    let mut stale = empty_state("", "/repo", start_ms());
    stale.runs = vec![run(ReleaseTrainRunState::Running, None)];

    for merged in [
        merge_state(&stale, &settled, &[]),
        merge_state(&settled, &stale, &[]),
    ] {
        assert_eq!(merged.runs.len(), 1);
        assert_eq!(merged.runs[0].state, ReleaseTrainRunState::Released);
        assert_eq!(
            merged.runs[0].ended_at.as_deref(),
            Some("2026-11-02T10:30:00.000Z")
        );
    }
}

/* ------------------------------------------------------------------------ */
/* Verification                                                              */
/* ------------------------------------------------------------------------ */

fn verification_options(
    repo_dir: &Path,
    target: &str,
    version: &str,
    activity: Arc<dyn Fn(&str) + Send + Sync>,
) -> ReleaseVerificationOptions {
    ReleaseVerificationOptions {
        repo_dir: repo_dir.to_path_buf(),
        target: target.to_string(),
        version: version.to_string(),
        environment: std::collections::HashMap::new(),
        activity,
        refresh: Some(Arc::new(|_repo: &Path| GitOutcome::ok(String::new()))),
        read_github_assets: None,
        read_release: None,
        read_retry: Some(ReadRetry {
            attempts: 2,
            delay: std::time::Duration::ZERO,
        }),
    }
}

fn github_asset_names() -> Vec<String> {
    let mut names: Vec<String> = RELEASE_TARGETS
        .iter()
        .map(|target| format!("devboard-{target}.tar.xz"))
        .collect();
    names.extend(RELEASE_INSTALLERS.iter().map(|name| name.to_string()));
    names
}

fn gitea_manifest_release(tag: String) -> ForgeRelease {
    ForgeRelease {
        asset_names: vec![
            MANIFEST_ASSET.to_string(),
            MANIFEST_CHECKSUM_ASSET.to_string(),
        ],
        url: format!("https://forge.test/releases/tag/{tag}"),
    }
}

#[tokio::test]
async fn verification_reads_the_github_assets_and_the_gitea_manifest() {
    let fixture = fixture("verify-assets-ok", true);
    let head = git(&fixture.repo, &["rev-parse", "HEAD"]);
    let activity: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let recorded = activity.clone();
    let mut options = verification_options(
        &fixture.repo,
        &head,
        "1.0.0",
        Arc::new(move |line: &str| {
            recorded
                .lock()
                .expect("the activity")
                .push(line.to_string());
        }),
    );
    options.read_github_assets = Some(Arc::new(|_tag: String| {
        Box::pin(async move { Ok(Some(github_asset_names())) })
    }));
    options.read_release = Some(Arc::new(|tag: String| {
        Box::pin(async move { Ok(Some(gitea_manifest_release(tag))) })
    }));
    let verified = verify_shipped(options).await;
    assert_eq!(
        verified,
        ReleaseVerification::Ok {
            version: "1.0.0".to_string(),
            url: "https://forge.test/releases/tag/v1.0.0".to_string(),
        }
    );
    let lines = activity.lock().expect("the activity").clone();
    assert!(
        lines.contains(&format!(
            "verified {} GitHub asset(s) for v1.0.0",
            github_asset_names().len()
        )),
        "{lines:?}"
    );
    assert!(
        lines.contains(&format!(
            "verified {MANIFEST_ASSET} and its checksum on Gitea for v1.0.0"
        )),
        "{lines:?}"
    );
}

#[tokio::test]
async fn verification_retries_a_read_that_failed_in_transport() {
    let fixture = fixture("verify-retry", true);
    let head = git(&fixture.repo, &["rev-parse", "HEAD"]);
    let mut options =
        verification_options(&fixture.repo, &head, "1.0.0", Arc::new(|_line: &str| {}));
    let attempts = Arc::new(AtomicUsize::new(0));
    let seen = attempts.clone();
    options.read_github_assets = Some(Arc::new(move |_tag: String| {
        let seen = seen.clone();
        Box::pin(async move {
            if seen.fetch_add(1, Ordering::SeqCst) == 0 {
                return Err("error sending request for url".to_string());
            }
            Ok(Some(github_asset_names()))
        })
    }));
    options.read_release = Some(Arc::new(|tag: String| {
        Box::pin(async move { Ok(Some(gitea_manifest_release(tag))) })
    }));
    let verified = verify_shipped(options).await;
    assert_eq!(
        verified,
        ReleaseVerification::Ok {
            version: "1.0.0".to_string(),
            url: "https://forge.test/releases/tag/v1.0.0".to_string(),
        }
    );
    assert_eq!(attempts.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn verification_names_the_tag_phase_when_no_tag_carries_the_commit() {
    let fixture = fixture("verify-tag", true);
    let missing = "b".repeat(40);
    let mut options =
        verification_options(&fixture.repo, &missing, "1.0.0", Arc::new(|_line: &str| {}));
    options.read_github_assets = Some(Arc::new(|_tag: String| {
        Box::pin(async move { Err("the GitHub phase must not run".to_string()) })
    }));
    options.read_release = Some(Arc::new(|_tag: String| {
        Box::pin(async move { Err("the Gitea phase must not run".to_string()) })
    }));
    match verify_shipped(options).await {
        ReleaseVerification::Failed {
            phase,
            version,
            detail,
        } => {
            assert_eq!(phase, ReleaseVerificationPhase::Tag);
            assert_eq!(version, "1.0.0");
            assert!(detail.starts_with("tag binding:"), "{detail}");
            assert!(detail.contains(&missing[..7]), "{detail}");
        }
        other => panic!("expected a tag failure, got {other:?}"),
    }
}

#[tokio::test]
async fn verification_names_the_missing_github_asset() {
    let fixture = fixture("verify-github-assets", true);
    let head = git(&fixture.repo, &["rev-parse", "HEAD"]);
    let mut options =
        verification_options(&fixture.repo, &head, "1.0.0", Arc::new(|_line: &str| {}));
    let mut assets = github_asset_names();
    assets.retain(|name| name != "devboard-x86_64-unknown-linux-gnu.tar.xz");
    options.read_github_assets = Some(Arc::new(move |_tag: String| {
        let assets = assets.clone();
        Box::pin(async move { Ok(Some(assets)) })
    }));
    options.read_release = Some(Arc::new(|_tag: String| {
        Box::pin(async move { Err("the Gitea phase must not run".to_string()) })
    }));
    match verify_shipped(options).await {
        ReleaseVerification::Failed { phase, detail, .. } => {
            assert_eq!(phase, ReleaseVerificationPhase::Github);
            assert!(detail.starts_with("GitHub assets:"), "{detail}");
            assert!(
                detail.contains("is missing devboard-x86_64-unknown-linux-gnu.tar.xz"),
                "{detail}"
            );
        }
        other => panic!("expected a GitHub failure, got {other:?}"),
    }
}

#[tokio::test]
async fn verification_names_the_missing_gitea_manifest_asset() {
    let fixture = fixture("verify-manifest", true);
    let head = git(&fixture.repo, &["rev-parse", "HEAD"]);
    let mut options =
        verification_options(&fixture.repo, &head, "1.0.0", Arc::new(|_line: &str| {}));
    options.read_github_assets = Some(Arc::new(|_tag: String| {
        Box::pin(async move { Ok(Some(github_asset_names())) })
    }));
    options.read_release = Some(Arc::new(|tag: String| {
        Box::pin(async move {
            Ok(Some(ForgeRelease {
                asset_names: vec![MANIFEST_ASSET.to_string()],
                url: format!("https://forge.test/releases/tag/{tag}"),
            }))
        })
    }));
    match verify_shipped(options).await {
        ReleaseVerification::Failed { phase, detail, .. } => {
            assert_eq!(phase, ReleaseVerificationPhase::Gitea);
            assert!(detail.starts_with("Gitea manifest:"), "{detail}");
            assert!(
                detail.contains(&format!("is missing {MANIFEST_CHECKSUM_ASSET}")),
                "{detail}"
            );
        }
        other => panic!("expected a Gitea failure, got {other:?}"),
    }
}

#[tokio::test]
async fn the_run_result_document_is_read_from_the_run_directory() {
    let workspace = workspace("result");
    let directory = release_train_directory(&workspace.state_dir);
    let run_dir = run_directory(&directory, "run-1");
    std::fs::create_dir_all(&run_dir).expect("a run directory");
    std::fs::write(
        run_dir.join("result.json"),
        serde_json::json!({"ok": false, "detail": "the release workflow concluded failure"})
            .to_string(),
    )
    .expect("the result document");
    assert_eq!(
        read_result(&run_dir),
        Some(serde_json::json!({
            "ok": false,
            "detail": "the release workflow concluded failure",
        }))
    );
    assert_eq!(read_result(&run_directory(&directory, "absent")), None);
}

/* ------------------------------------------------------------------------ */
/* Types reused by the assertions                                            */
/* ------------------------------------------------------------------------ */

use serde_json::Value;

#[tokio::test(flavor = "multi_thread")]
async fn the_release_agent_is_one_omp_peer_named_in_the_state_and_stopped_by_stop() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    let root = scratch_root("release-agent");
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).expect("a repo");
    let run_dir = root.join("run");
    std::fs::create_dir_all(&run_dir).expect("a run directory");
    let stub = format!(
        "{} acp-stub --delay-ms=60000",
        env!("CARGO_BIN_EXE_devboard")
    );
    let stopped = Arc::new(AtomicBool::new(false));
    let registered: Arc<Mutex<Option<devboard::workers::release_train::ReleasePeer>>> =
        Arc::new(Mutex::new(None));
    let input = ReleaseRunInput {
        request: ReleaseTrainRequest {
            format: 1,
            run_id: "run-1".to_string(),
            range: "v1.0.0..abc".to_string(),
            target: "abc".to_string(),
            version: "1.1.0".to_string(),
            previous: Some("v1.0.0".to_string()),
            commits: Vec::new(),
            release_commits: Vec::new(),
        },
        activity: Arc::new(|_line: &str| {}),
        stopping: {
            let stopped = stopped.clone();
            Arc::new(move || stopped.load(Ordering::SeqCst))
        },
        run_dir: run_dir.clone(),
        repo_dir: repo.clone(),
        state_dir: root.join("state"),
        agent_command: stub,
        timeouts: ReleaseRunTimeouts::default(),
        register_peer: {
            let registered = registered.clone();
            Arc::new(move |peer| *registered.lock().unwrap() = Some(peer))
        },
    };
    let verify: VerifyFn = Arc::new(|_options| {
        Box::pin(async {
            ReleaseVerification::Ok {
                version: "1.1.0".to_string(),
                url: "https://forge.test/releases/tag/v1.1.0".to_string(),
            }
        })
    });
    let run = devboard::workers::release_train::default_release_agent_runner(
        verify,
        std::collections::HashMap::new(),
    );
    let handle = tokio::spawn(run(input));
    let peer = tokio::time::timeout(std::time::Duration::from_secs(20), async {
        loop {
            if let Some(peer) = registered.lock().unwrap().clone() {
                return peer;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("the peer starts");
    assert!(peer.command.contains("acp-stub"), "{:?}", peer.argv);
    assert!(peer.pid > 0);

    stopped.store(true, Ordering::SeqCst);
    let result = tokio::time::timeout(std::time::Duration::from_secs(20), handle)
        .await
        .expect("Stop ends the peer")
        .expect("the run joins");
    assert!(
        matches!(
            result,
            ReleaseRunResult::Ok { .. } | ReleaseRunResult::Failed { .. }
        ),
        "{result:?}"
    );
    // The process group is gone.
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let alive = std::path::Path::new(&format!("/proc/{}", peer.pid)).exists();
    assert!(!alive, "the release peer survived Stop");
}

/// One run input for the real `acp-stub`, with the bounds the test names.
fn stub_run_input(root: &Path, stub: String, timeouts: ReleaseRunTimeouts) -> ReleaseRunInput {
    let run_dir = root.join("run");
    std::fs::create_dir_all(&run_dir).expect("a run directory");
    ReleaseRunInput {
        request: ReleaseTrainRequest {
            format: 1,
            run_id: "run-1".to_string(),
            range: "v1.0.0..abc".to_string(),
            target: "a".repeat(40),
            version: "1.1.0".to_string(),
            previous: Some("v1.0.0".to_string()),
            commits: Vec::new(),
            release_commits: Vec::new(),
        },
        activity: Arc::new(|_line: &str| {}),
        stopping: Arc::new(|| false),
        run_dir,
        repo_dir: root.join("repo"),
        state_dir: root.join("state"),
        agent_command: stub,
        timeouts,
        register_peer: Arc::new(|_peer| {}),
    }
}

/// A release legitimately compiles, rebuilds the client, runs the workspace
/// suite up to nine times, and waits for the workflow, so one run can last well
/// past an hour. The bound is silence: a peer that keeps reporting progress is
/// working, and it is never failed for taking longer than the silence window.
#[tokio::test(flavor = "multi_thread")]
async fn a_release_peer_that_keeps_reporting_progress_is_never_timed_out() {
    let root = scratch_root("release-agent-progress");
    std::fs::create_dir_all(root.join("repo")).expect("a repo");
    let stub = format!(
        "{} acp-stub --delay-ms=1500 --tick-ms=100",
        env!("CARGO_BIN_EXE_devboard")
    );
    let input = stub_run_input(
        &root,
        stub,
        ReleaseRunTimeouts {
            silence: std::time::Duration::from_millis(500),
            max: std::time::Duration::from_secs(60),
        },
    );
    let verify: VerifyFn = Arc::new(|options| {
        Box::pin(async move {
            ReleaseVerification::Ok {
                version: options.version.clone(),
                url: "https://forge.test/releases/tag/v1.1.0".to_string(),
            }
        })
    });
    let run = devboard::workers::release_train::default_release_agent_runner(
        verify,
        std::collections::HashMap::new(),
    );
    let result = tokio::time::timeout(std::time::Duration::from_secs(30), run(input))
        .await
        .expect("the busy peer outlives the silence window and ends its turn");
    assert_eq!(
        result,
        ReleaseRunResult::Ok {
            version: "1.1.0".to_string(),
            url: "https://forge.test/releases/tag/v1.1.0".to_string(),
        }
    );
}

/// The other half of that bound: a peer that reports nothing is stuck, and the
/// run names the silence it observed instead of the total runtime it happened
/// to reach.
#[tokio::test(flavor = "multi_thread")]
async fn a_release_peer_that_reports_nothing_fails_with_the_silence_detail() {
    let root = scratch_root("release-agent-silent");
    std::fs::create_dir_all(root.join("repo")).expect("a repo");
    let stub = format!(
        "{} acp-stub --delay-ms=60000",
        env!("CARGO_BIN_EXE_devboard")
    );
    let input = stub_run_input(
        &root,
        stub,
        ReleaseRunTimeouts {
            silence: std::time::Duration::from_millis(300),
            max: std::time::Duration::from_secs(60),
        },
    );
    let verify: VerifyFn = Arc::new(|options| {
        Box::pin(async move {
            ReleaseVerification::Failed {
                phase: ReleaseVerificationPhase::Tag,
                version: options.version.clone(),
                detail: format!(
                    "tag binding: no release tag names or contains {} for v{}",
                    &options.target[..7],
                    options.version
                ),
            }
        })
    });
    let run = devboard::workers::release_train::default_release_agent_runner(
        verify,
        std::collections::HashMap::new(),
    );
    let result = tokio::time::timeout(std::time::Duration::from_secs(30), run(input))
        .await
        .expect("the silent peer is closed at the silence bound");
    assert_eq!(
        result,
        ReleaseRunResult::failed("the release agent produced no output for 300 ms")
    );
}
